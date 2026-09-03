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
    writes = []

    def do_PUT(self):
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        SentryHandler.writes.append((self.path, payload))
        self.respond({"status": "resolved"})

    def do_GET(self):
        if self.path == "/api/0/organizations/test/issues/1/":
            self.respond({"shortId": "TEST-1", "status": "unresolved"})
            return
        if self.path == "/api/0/organizations/test/issues/2/":
            self.respond({"shortId": "TEST-2", "status": "resolved"})
            return
        if self.path == "/api/0/organizations/test/issues/3/":
            self.respond(
                {"shortId": "TEST-3", "status": "unresolved", "project": {"slug": "elsewhere"}}
            )
            return
        if self.path == "/api/0/organizations/test/releases/live/":
            self.respond({"version": "live", "projects": [{"slug": "site"}]})
            return
        if self.path == "/api/0/organizations/test/releases/other/":
            self.respond({"version": "other", "projects": [{"slug": "elsewhere"}]})
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


    def run_resolve(self, *arguments):
        SentryHandler.writes = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), SentryHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        env = dict(os.environ)
        env["SENTRY_AUTH_TOKEN"] = "test-token"
        env["SENTRY_URL"] = f"http://127.0.0.1:{server.server_port}"
        try:
            return subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).with_name("sentry_api.py")),
                    "--org",
                    "test",
                    "resolve",
                    "--project",
                    "site",
                    *arguments,
                ],
                capture_output=True,
                check=False,
                env=env,
                text=True,
            )
        finally:
            server.shutdown()
            server.server_close()

    def test_resolve_reports_the_plan_and_writes_nothing_without_apply(self):
        result = self.run_resolve("--issue", "1", "--in-next-release")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["applied"])
        self.assertEqual(payload["would_resolve"], ["1"])
        self.assertEqual(payload["mode"], "in-next-release")
        self.assertEqual(SentryHandler.writes, [])

    def test_resolve_apply_sends_in_next_release(self):
        result = self.run_resolve("--issue", "1", "--in-next-release", "--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["resolved"], ["1"])
        self.assertEqual(len(SentryHandler.writes), 1)
        path, body = SentryHandler.writes[0]
        self.assertIn("id=1", path)
        self.assertEqual(body["status"], "resolved")
        self.assertEqual(body["statusDetails"], {"inNextRelease": True})

    def test_resolve_apply_sends_the_named_release(self):
        result = self.run_resolve("--issue", "1", "--in-release", "live", "--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            SentryHandler.writes[0][1]["statusDetails"], {"inRelease": "live"}
        )

    def test_resolve_rejects_a_release_the_project_does_not_hold(self):
        result = self.run_resolve("--issue", "1", "--in-release", "other", "--apply")
        self.assertEqual(result.returncode, 1)
        self.assertIn("not associated with project site", result.stderr)
        self.assertEqual(SentryHandler.writes, [])

    def test_resolve_skips_an_issue_already_resolved(self):
        result = self.run_resolve("--issue", "2", "--in-next-release", "--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["already_resolved"], ["2"])
        self.assertEqual(payload["would_resolve"], [])
        self.assertEqual(SentryHandler.writes, [])

    def test_resolve_rejects_an_issue_from_a_different_project(self):
        result = self.run_resolve("--issue", "3", "--in-next-release", "--apply")
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not belong to project site", result.stderr)
        self.assertEqual(SentryHandler.writes, [])

    def test_resolve_rejects_a_non_numeric_issue(self):
        result = self.run_resolve("--issue", "TEST-1", "--in-next-release", "--apply")
        self.assertEqual(result.returncode, 1)
        self.assertIn("numeric issue ID", result.stderr)
        self.assertEqual(SentryHandler.writes, [])


FULL_BUNDLE = {
    "project": "site",
    "issue": {
        "id": "1",
        "shortId": "SITE-1",
        "title": "TypeError: x is undefined",
        "culprit": "app/pages/index.vue",
        "level": "error",
        "status": "unresolved",
        "count": "12",
        "userCount": 4,
        "firstSeen": "2026-08-10T00:00:00Z",
        "lastSeen": "2026-08-28T00:00:00Z",
    },
    "events": [
        {
            "eventID": "event-1",
            "release": {"version": "abc123"},
            "environment": "production",
            "entries": [
                {
                    "type": "exception",
                    "data": {
                        "values": [
                            {
                                "type": "TypeError",
                                "value": "x is undefined",
                                "stacktrace": {
                                    "frames": [
                                        {"filename": "node_modules/vue/runtime.js", "function": "render", "lineno": 1, "in_app": False},
                                        {"filename": "app/pages/index.vue", "function": "setup", "lineno": 42, "in_app": True},
                                        {"filename": "app/utils/read.ts", "function": "read", "lineno": 7, "in_app": True},
                                    ]
                                },
                            }
                        ]
                    },
                }
            ],
        }
    ],
}
COMPACT_BUNDLE = {
    "project": "site",
    "issue": {
        "id": "2",
        "short_id": "SITE-2",
        "title": "Error: boom",
        "culprit": "server/api/boom.ts",
        "count": "3",
        "user_count": 1,
        "first_seen": "2026-08-20T00:00:00Z",
        "last_seen": "2026-08-21T00:00:00Z",
    },
    "events": [
        {
            "release": "def456",
            "exceptions": [
                {
                    "type": "Error",
                    "value": "boom",
                    "frames": [
                        {"filename": "server/api/boom.ts", "function": "handler", "lineno": 3, "in_app": True}
                    ],
                }
            ],
        }
    ],
}


class DigestTest(unittest.TestCase):
    def write_bundles(self, directory, bundles):
        bundles_dir = Path(directory) / "bundles"
        bundles_dir.mkdir(exist_ok=True)
        for bundle in bundles:
            issue_id = str(bundle["issue"]["id"])
            (bundles_dir / f"{issue_id}.json").write_text(json.dumps(bundle))
        (bundles_dir / "manifest.json").write_text(
            json.dumps(
                {
                    "org": "test",
                    "project": "site",
                    "completed": {str(bundle["issue"]["id"]): "x" for bundle in bundles},
                    "errors": {},
                }
            )
        )
        return bundles_dir

    def run_digest(self, bundles_dir, state, *arguments):
        result = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).with_name("sentry_api.py")),
                "--org",
                "test",
                "digest",
                "--project",
                "site",
                "--bundles",
                str(bundles_dir),
                "--state",
                str(state),
                *arguments,
            ],
            capture_output=True,
            check=False,
            env={**os.environ, "SENTRY_AUTH_TOKEN": ""},
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        return json.loads(result.stdout)

    def test_digest_summarizes_full_and_compact_bundles_without_a_token(self):
        with tempfile.TemporaryDirectory() as directory:
            bundles_dir = self.write_bundles(directory, [FULL_BUNDLE, COMPACT_BUNDLE])
            digest = self.run_digest(bundles_dir, Path(directory) / "state.json")
            full, compact = digest["issues"]
            self.assertEqual(full["short_id"], "SITE-1")
            self.assertEqual(full["event_count"], "12")
            self.assertEqual(full["user_count"], 4)
            self.assertEqual(full["release"], "abc123")
            self.assertEqual(full["exception"]["type"], "TypeError")
            self.assertEqual(
                [(frame["file"], frame["function"]) for frame in full["frames"]],
                [("app/utils/read.ts", "read"), ("app/pages/index.vue", "setup")],
            )
            self.assertEqual(compact["release"], "def456")
            self.assertEqual(compact["frames"][0]["file"], "server/api/boom.ts")
            self.assertTrue(all(entry["fingerprint"].startswith("sentry:") for entry in digest["issues"]))
            self.assertFalse(digest["snapshot_unchanged"])
            self.assertEqual([entry["runs_seen"] for entry in digest["issues"]], [1, 1])

    def test_digest_reports_a_zero_user_count_from_a_compact_bundle(self):
        zero = json.loads(json.dumps(COMPACT_BUNDLE))
        zero["issue"]["user_count"] = 0
        with tempfile.TemporaryDirectory() as directory:
            bundles_dir = self.write_bundles(directory, [zero])
            digest = self.run_digest(bundles_dir, Path(directory) / "state.json")
            self.assertEqual(digest["issues"][0]["user_count"], 0)

    def test_digest_gives_frameless_issues_with_one_culprit_distinct_fingerprints(self):
        frameless = {
            "project": "site",
            "issue": {
                "id": "10",
                "short_id": "SITE-10",
                "title": "Error: first",
                "culprit": "server/api/gone.ts",
                "count": "1",
                "user_count": 1,
                "first_seen": "2026-08-20T00:00:00Z",
                "last_seen": "2026-08-21T00:00:00Z",
            },
            "events": [{"eventID": "event-a"}],
        }
        sibling = json.loads(json.dumps(frameless))
        sibling["issue"]["id"] = "11"
        sibling["issue"]["short_id"] = "SITE-11"
        sibling["issue"]["title"] = "Error: second"
        with tempfile.TemporaryDirectory() as directory:
            bundles_dir = self.write_bundles(directory, [frameless, sibling])
            digest = self.run_digest(bundles_dir, Path(directory) / "state.json")
            first, second = digest["issues"]
            self.assertNotEqual(first["fingerprint"], second["fingerprint"])

    def test_digest_flags_an_unchanged_backlog_on_the_next_run(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            bundles_dir = self.write_bundles(directory, [FULL_BUNDLE, COMPACT_BUNDLE])
            first = self.run_digest(bundles_dir, state, "--run-id", "run-1")
            second = self.run_digest(bundles_dir, state, "--run-id", "run-2")
            self.assertTrue(second["snapshot_unchanged"])
            self.assertTrue(second["all_unchanged"])
            self.assertEqual(second["previous_run"]["run_id"], "run-1")
            self.assertEqual([entry["runs_seen"] for entry in second["issues"]], [2, 2])
            self.assertEqual(
                [entry["fingerprint"] for entry in first["issues"]],
                [entry["fingerprint"] for entry in second["issues"]],
            )

            grown = json.loads(json.dumps(FULL_BUNDLE))
            grown["issue"]["count"] = "13"
            grown["issue"]["lastSeen"] = "2026-09-01T00:00:00Z"
            bundles_dir = self.write_bundles(directory, [grown, COMPACT_BUNDLE])
            third = self.run_digest(bundles_dir, state, "--no-record")
            self.assertTrue(third["snapshot_unchanged"])
            self.assertFalse(third["all_unchanged"])
            self.assertEqual(third["changed_issue_ids"], ["1"])
            self.assertFalse(third["recorded"])
            self.assertEqual(json.loads(state.read_text())["run_id"], "run-2")

    def test_digest_sees_a_new_issue_set_as_changed(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            self.run_digest(self.write_bundles(directory, [FULL_BUNDLE]), state)
            digest = self.run_digest(
                self.write_bundles(directory, [FULL_BUNDLE, COMPACT_BUNDLE]), state
            )
            self.assertFalse(digest["snapshot_unchanged"])
            self.assertEqual(digest["changed_issue_ids"], ["2"])

    def test_compact_bundle_warns_that_frames_are_dropped(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), SentryHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
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
                    "bundle",
                    "--project",
                    "site",
                    "--issue",
                    "1",
                    "--compact",
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
        self.assertIn("drops thread and raw frames", result.stderr)


if __name__ == "__main__":
    unittest.main()
