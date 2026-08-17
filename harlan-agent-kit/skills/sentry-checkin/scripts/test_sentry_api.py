#!/usr/bin/env python3

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class SentryHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/0/organizations/test/issues/1/":
            self.respond({"shortId": "TEST-1"})
            return
        if self.path.startswith("/api/0/organizations/test/issues/1/events/"):
            self.respond(
                [{"eventID": "event-1"}],
                {"Link": '<http://example.test>; rel="next"; results="true"; cursor="next"'},
            )
            return
        if self.path == "/api/0/projects/test/site/events/event-1/":
            self.respond({"eventID": "event-1", "entries": []})
            return
        self.send_error(404)

    def log_message(self, _format, *_args):
        pass

    def respond(self, value, headers=None):
        body = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, item in (headers or {}).items():
            self.send_header(key, item)
        self.end_headers()
        self.wfile.write(body)


class SentryApiTest(unittest.TestCase):
    def test_snapshot_invokes_cli_and_writes_exact_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "fake_cli.py"
            fixture.write_text(
                """#!/usr/bin/env python3
print('''+----------+----------+----------------------+-----------------------------+------------+-------+
| Issue ID | Short ID | Title                | Last seen                   | Status     | Level |
+----------+----------+----------------------+-----------------------------+------------+-------+
| 123      | SITE-1   | A long title that... | 2026-08-13T00:00:00.000000Z | unresolved | error |
+----------+----------+----------------------+-----------------------------+------------+-------+''')
"""
            )
            output = Path(directory) / "snapshot.json"
            env = dict(os.environ)
            env["SENTRY_CLI_COMMAND"] = f"{sys.executable} {fixture}"
            result = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).with_name("sentry_api.py")),
                    "--org",
                    "test",
                    "snapshot",
                    "--project",
                    "site",
                    "--output",
                    str(output),
                ],
                capture_output=True,
                check=False,
                env=env,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            snapshot = json.loads(output.read_text())
            self.assertEqual([issue["id"] for issue in snapshot["issues"]], ["123"])
            self.assertTrue(snapshot["issues"][0]["title_truncated"])

    def test_snapshot_drops_duplicate_ids_and_reports_the_drop(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "fake_cli.py"
            fixture.write_text(
                """#!/usr/bin/env python3
print('''+----------+----------+----------------------+-----------------------------+------------+-------+
| Issue ID | Short ID | Title                | Last seen                   | Status     | Level |
+----------+----------+----------------------+-----------------------------+------------+-------+
| 500      | SITE-2   | Second               | 2026-08-13T00:00:00.000000Z | unresolved | error |
| 123      | SITE-1   | First                | 2026-08-13T00:00:00.000000Z | unresolved | error |
| 500      | SITE-2   | Second               | 2026-08-13T00:00:00.000000Z | unresolved | error |
+----------+----------+----------------------+-----------------------------+------------+-------+''')
"""
            )
            output = Path(directory) / "snapshot.json"
            env = dict(os.environ)
            env["SENTRY_CLI_COMMAND"] = f"{sys.executable} {fixture}"
            result = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).with_name("sentry_api.py")),
                    "--org",
                    "test",
                    "snapshot",
                    "--project",
                    "site",
                    "--output",
                    str(output),
                ],
                capture_output=True,
                check=False,
                env=env,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            snapshot = json.loads(output.read_text())
            self.assertEqual([issue["id"] for issue in snapshot["issues"]], ["123", "500"])
            self.assertEqual(snapshot["issue_count"], 2)
            self.assertEqual(snapshot["duplicate_ids_dropped"], ["500"])

    def test_snapshot_checksum_ignores_cli_row_order(self):
        digests = []
        for rows in (
            "| 123      | SITE-1   | First  | 2026-08-13T00:00:00.000000Z | unresolved | error |\n"
            "| 500      | SITE-2   | Second | 2026-08-13T00:00:00.000000Z | unresolved | error |",
            "| 500      | SITE-2   | Second | 2026-08-13T00:00:00.000000Z | unresolved | error |\n"
            "| 123      | SITE-1   | First  | 2026-08-13T00:00:00.000000Z | unresolved | error |",
        ):
            with tempfile.TemporaryDirectory() as directory:
                fixture = Path(directory) / "fake_cli.py"
                fixture.write_text(
                    "#!/usr/bin/env python3\nprint('''"
                    "+----------+----------+--------+-----------------------------+------------+-------+\n"
                    "| Issue ID | Short ID | Title  | Last seen                   | Status     | Level |\n"
                    "+----------+----------+--------+-----------------------------+------------+-------+\n"
                    f"{rows}\n"
                    "+----------+----------+--------+-----------------------------+------------+-------+''')\n"
                )
                output = Path(directory) / "snapshot.json"
                env = dict(os.environ)
                env["SENTRY_CLI_COMMAND"] = f"{sys.executable} {fixture}"
                result = subprocess.run(
                    [
                        sys.executable,
                        str(Path(__file__).with_name("sentry_api.py")),
                        "--org",
                        "test",
                        "snapshot",
                        "--project",
                        "site",
                        "--output",
                        str(output),
                    ],
                    capture_output=True,
                    check=False,
                    env=env,
                    text=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                digests.append(json.loads(output.read_text())["issue_ids_sha256"])
        self.assertEqual(digests[0], digests[1])

    def test_bundle_returns_requested_event_count(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), SentryHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        env = dict(os.environ)
        env["SENTRY_AUTH_TOKEN"] = "test-token"
        env["SENTRY_URL"] = f"http://127.0.0.1:{server.server_port}"
        script = Path(__file__).with_name("sentry_api.py")
        try:
            result = subprocess.run(
                [
                    sys.executable,
                    str(script),
                    "--org",
                    "test",
                    "bundle",
                    "--project",
                    "site",
                    "--issue",
                    "1",
                    "--events",
                    "1",
                ],
                capture_output=True,
                check=False,
                env=env,
                text=True,
            )
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(result.stdout)["events"]), 1)

    def test_bulk_bundle_writes_resumable_manifest(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), SentryHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / "snapshot.json"
            snapshot.write_text(
                json.dumps(
                    {
                        "org": "test",
                        "project": "site",
                        "issues": [{"id": "1", "short_id": "TEST-1"}],
                    }
                )
            )
            output = Path(directory) / "bundles"
            env = dict(os.environ)
            env["SENTRY_AUTH_TOKEN"] = "test-token"
            env["SENTRY_URL"] = f"http://127.0.0.1:{server.server_port}"
            try:
                result = subprocess.run(
                    [
                        sys.executable,
                        str(Path(__file__).with_name("sentry_api.py")),
                        "--org",
                        "test",
                        "bulk-bundles",
                        "--project",
                        "site",
                        "--snapshot",
                        str(snapshot),
                        "--output",
                        str(output),
                    ],
                    capture_output=True,
                    check=False,
                    env=env,
                    text=True,
                )
            finally:
                server.shutdown()
                server.server_close()
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads((output / "manifest.json").read_text())
            self.assertEqual(list(manifest["completed"]), ["1"])
            self.assertEqual(json.loads((output / "1.json").read_text())["project"], "site")


if __name__ == "__main__":
    unittest.main()
