import json
import os
from pathlib import Path
import subprocess
import socket
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("harlan-browser.py")


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
            self.assertEqual(args[-1], "https://example.com")
            self.assertEqual((self.root / "profiles" / identity).stat().st_mode & 0o777, 0o700)

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
