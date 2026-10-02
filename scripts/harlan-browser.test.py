import importlib.util
import json
import os
from pathlib import Path
import subprocess
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("harlan-browser.py")

SPEC = importlib.util.spec_from_file_location("harlan_browser", SCRIPT)
CLI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CLI)


class BrowserCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.record = self.root / "chrome-args.json"
        chrome = self.root / "google-chrome"
        chrome.write_text("#!/usr/bin/env python3\nimport json, os, sys\nfrom pathlib import Path\nPath(os.environ['BROWSER_TEST_RECORD']).write_text(json.dumps(sys.argv[1:]))\n")
        chrome.chmod(0o755)
        self.ports = {}
        for identity in ["CLIENTS", "AGENT"]:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                self.ports[identity] = probe.getsockname()[1]
        self.env = dict(os.environ, HARLAN_BROWSER_CLIENTS_PORT=str(self.ports["CLIENTS"]),
                        HARLAN_BROWSER_AGENT_PORT=str(self.ports["AGENT"]), PATH=str(self.root) + os.pathsep + os.environ["PATH"],
                        HARLAN_BROWSER_ROOT=str(self.root / "profiles"), BROWSER_TEST_RECORD=str(self.record), DISPLAY=":0")

    def call(self, *args):
        return subprocess.run(["python3", str(SCRIPT), *args], env=self.env,
                              text=True, capture_output=True, timeout=5)

    def test_unknown_identity_does_not_launch_chrome(self):
        result = self.call("open", "harlan")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("clients or agent", result.stderr)
        self.assertFalse(self.record.exists())

    def test_browser_flags_cannot_be_injected_as_urls(self):
        result = self.call("open", "agent", "--user-data-dir=/tmp/wrong")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.record.exists())

    def test_open_passes_isolated_debugging_arguments(self):
        for identity, port in [("clients", self.ports["CLIENTS"]), ("agent", self.ports["AGENT"])]:
            result = self.call("open", identity, "https://example.com")
            self.assertEqual(result.returncode, 0, result.stderr)
            args = json.loads(self.record.read_text())
            self.assertIn(f"--user-data-dir={self.root / 'profiles' / identity}", args)
            self.assertIn(f"--remote-debugging-port={port}", args)
            self.assertIn("--headless", args)
            self.assertEqual(args[-1], "https://example.com")
            self.assertEqual((self.root / "profiles" / identity).stat().st_mode & 0o777, 0o700)

    def test_open_defaults_to_headless_without_a_display(self):
        self.env.pop("DISPLAY", None)
        self.env.pop("WAYLAND_DISPLAY", None)
        result = self.call("open", "agent")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--headless", json.loads(self.record.read_text()))

    def test_headed_open_requires_a_display(self):
        self.env.pop("DISPLAY", None)
        self.env.pop("WAYLAND_DISPLAY", None)
        result = self.call("open", "agent", "--headed")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("desktop session", result.stderr)
        self.assertFalse(self.record.exists())

    def test_headed_open_is_explicit(self):
        result = self.call("open", "clients", "--headed", "https://example.com")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("--headless", json.loads(self.record.read_text()))

    def test_open_reuses_a_running_headless_browser_without_launching(self):
        with patch.dict(os.environ, self.env), patch.object(CLI, "owner", return_value={
            "pid": 123, "debugging": True, "headless": True
        }), patch.object(CLI.os, "execvp") as launch:
            CLI.main(["open", "agent"])
            launch.assert_not_called()

    def test_open_refuses_to_change_a_running_browser_mode(self):
        for headless, flags in [(False, []), (True, ["--headed"])]:
            with patch.dict(os.environ, self.env), patch.object(CLI, "owner", return_value={
                "pid": 123, "debugging": True, "headless": headless
            }), patch.object(CLI.os, "execvp") as launch:
                with self.assertRaises(SystemExit):
                    CLI.main(["open", "agent", *flags])
                launch.assert_not_called()

    def test_connect_refuses_a_visible_browser_without_explicit_opt_in(self):
        with patch.object(CLI, "status", return_value={
            "ready": True, "headless": False, "endpoint": "http://127.0.0.1:9224"
        }), patch.object(CLI.os, "execvp") as connect:
            with self.assertRaises(SystemExit):
                CLI.main(["connect", "agent", "test-task"])
            connect.assert_not_called()
            CLI.main(["connect", "agent", "test-task", "--headed"])
            connect.assert_called_once_with("dev-browser", ["dev-browser", "--browser",
                "agent-test-task", "--connect", "http://127.0.0.1:9224"])

    def test_connect_delegates_to_the_verified_headless_endpoint(self):
        with patch.object(CLI, "status", return_value={
            "ready": True, "headless": True, "endpoint": "http://127.0.0.1:9224"
        }), patch.object(CLI.os, "execvp") as connect:
            CLI.main(["connect", "agent", "test-task"])
            connect.assert_called_once_with("dev-browser", ["dev-browser", "--browser",
                "agent-test-task", "--connect", "http://127.0.0.1:9224"])

    def test_connect_does_not_use_an_unavailable_profile(self):
        result = self.call("connect", "agent", "test-task")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("harlan-browser open agent", result.stderr)

    def test_shared_profile_symlink_cannot_launch(self):
        directory = self.root / "profiles"
        (directory / "agent").mkdir(parents=True)
        (directory / "clients").symlink_to(directory / "agent")
        result = self.call("open", "clients")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.record.exists())

    def test_non_chrome_listener_cannot_impersonate_agent(self):
        fake = self.root / "fake-browser.py"
        fake.write_text("from http.server import HTTPServer, BaseHTTPRequestHandler\nimport json, sys\nport=int(sys.argv[-1].split('=')[1])\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write(json.dumps({'webSocketDebuggerUrl':f'ws://127.0.0.1:{port}/devtools/browser/unrelated'}).encode())\n def log_message(self,*args): pass\nserver=HTTPServer(('127.0.0.1',port),Handler)\nprint('ready',flush=True)\nserver.serve_forever()\n")
        # Start a real listener with browser-like arguments. Its executable is Python.
        port = self.ports["AGENT"]
        process = subprocess.Popen([sys.executable, str(fake),
            f"--user-data-dir={self.root / 'profiles' / 'agent'}", f"--remote-debugging-port={port}"],
            stdout=subprocess.PIPE, text=True)
        self.addCleanup(process.stdout.close)
        self.addCleanup(process.wait)
        self.addCleanup(process.terminate)
        self.assertEqual(process.stdout.readline().strip(), "ready")
        result = self.call("status", "agent")
        self.assertFalse(json.loads(result.stdout)["ready"])

    def test_status_reports_unavailable_identity(self):
        result = self.call("status", "agent")
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertFalse(value["ready"])
        self.assertEqual(value["identity"], "agent")


if __name__ == "__main__":
    unittest.main()
