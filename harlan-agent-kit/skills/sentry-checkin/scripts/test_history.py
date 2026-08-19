#!/usr/bin/env python3

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import ledger


def ledger_row(numeric_id, disposition, **overrides):
    row = {
        "numeric_id": numeric_id,
        "short_id": f"SITE-{numeric_id}",
        "project": "site",
        "root_cause": "root",
        "disposition": disposition,
        "owning_issue": "",
        "owning_fix": "",
        "evidence": "event stack",
    }
    row.update(overrides)
    return row


class HistoryRowsTest(unittest.TestCase):
    def test_projects_complete_rows_with_the_run_identity(self):
        rows = ledger.history_rows_from_ledger(
            [ledger_row("7", "third-party", owning_fix="ignoreErrors")],
            run_id="run-A",
            run_date="2026-08-19",
        )
        self.assertEqual(
            rows,
            [
                {
                    "run_id": "run-A",
                    "run_date": "2026-08-19",
                    "numeric_id": "7",
                    "short_id": "SITE-7",
                    "project": "site",
                    "disposition": "third-party",
                    "owning_fix": "ignoreErrors",
                    "root_cause": "root",
                }
            ],
        )

    def test_rejects_a_ledger_row_with_no_disposition(self):
        with self.assertRaises(RuntimeError) as caught:
            ledger.history_rows_from_ledger(
                [ledger_row("7", "")], run_id="run-A", run_date="2026-08-19"
            )
        self.assertIn("7", str(caught.exception))

    def test_rejects_a_run_date_that_is_not_an_iso_date(self):
        with self.assertRaises(ValueError):
            ledger.history_rows_from_ledger(
                [ledger_row("7", "fixed")], run_id="run-A", run_date="19 Aug 2026"
            )


class ClassifySnapshotTest(unittest.TestCase):
    def history(self, *triples):
        return [
            {
                "run_id": run_id,
                "run_date": run_date,
                "numeric_id": numeric_id,
                "short_id": f"SITE-{numeric_id}",
                "project": "site",
                "disposition": disposition,
                "owning_fix": "",
                "root_cause": "root",
            }
            for run_id, run_date, numeric_id, disposition in triples
        ]

    def test_an_unseen_id_is_new(self):
        result = ledger.classify_snapshot(["7"], [])
        self.assertEqual(result["7"]["state"], "new")
        self.assertIsNone(result["7"]["prior_disposition"])

    def test_an_id_last_seen_as_third_party_is_recurring(self):
        result = ledger.classify_snapshot(
            ["7"], self.history(("run-A", "2026-08-16", "7", "third-party"))
        )
        self.assertEqual(result["7"]["state"], "recurring")
        self.assertEqual(result["7"]["prior_disposition"], "third-party")

    def test_an_id_last_seen_as_fixed_is_unclosed(self):
        result = ledger.classify_snapshot(
            ["7"], self.history(("run-A", "2026-08-16", "7", "fixed"))
        )
        self.assertEqual(result["7"]["state"], "unclosed")

    def test_an_id_last_seen_as_already_fixed_is_unclosed(self):
        result = ledger.classify_snapshot(
            ["7"], self.history(("run-A", "2026-08-16", "7", "already-fixed"))
        )
        self.assertEqual(result["7"]["state"], "unclosed")

    def test_an_excluded_run_is_not_its_own_prior(self):
        history = self.history(("run-A", "2026-08-19", "7", "fixed"))
        self.assertEqual(
            ledger.classify_snapshot(["7"], history, exclude_runs={"run-A"})["7"]["state"],
            "new",
        )

    def test_the_most_recent_run_decides_the_state(self):
        result = ledger.classify_snapshot(
            ["7"],
            self.history(
                ("run-A", "2026-08-14", "7", "fixed"),
                ("run-B", "2026-08-17", "7", "blocked"),
            ),
        )
        self.assertEqual(result["7"]["state"], "recurring")
        self.assertEqual(result["7"]["prior_disposition"], "blocked")
        self.assertEqual(result["7"]["prior_run_id"], "run-B")
        self.assertEqual(result["7"]["runs_seen"], 2)


class AppendHistoryTest(unittest.TestCase):
    def test_re_recording_the_same_run_adds_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.tsv"
            rows = ledger.history_rows_from_ledger(
                [ledger_row("7", "blocked")], run_id="run-A", run_date="2026-08-19"
            )
            self.assertEqual(ledger.append_history(path, rows), 1)
            self.assertEqual(ledger.append_history(path, rows), 0)
            self.assertEqual(len(ledger.read_history(path)), 1)

    def test_a_later_run_appends_a_second_row_for_the_same_issue(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.tsv"
            ledger.append_history(
                path,
                ledger.history_rows_from_ledger(
                    [ledger_row("7", "fixed")], run_id="run-A", run_date="2026-08-16"
                ),
            )
            ledger.append_history(
                path,
                ledger.history_rows_from_ledger(
                    [ledger_row("7", "blocked")], run_id="run-B", run_date="2026-08-19"
                ),
            )
            self.assertEqual(len(ledger.read_history(path)), 2)


class HistoryCommandTest(unittest.TestCase):
    def test_record_then_history_reports_an_unclosed_issue(self):
        script = Path(__file__).with_name("ledger.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            history = root / "history.tsv"
            ledger.write_ledger(root / "ledger.tsv", [ledger_row("7", "fixed")])
            recorded = subprocess.run(
                [
                    sys.executable, str(script), "record",
                    "--ledger", str(root / "ledger.tsv"),
                    "--run-id", "run-A",
                    "--run-date", "2026-08-16",
                    "--history", str(history),
                ],
                capture_output=True, check=False, text=True,
            )
            self.assertEqual(recorded.returncode, 0, recorded.stderr)
            self.assertEqual(json.loads(recorded.stdout)["appended"], 1)

            snapshot = root / "snapshot.json"
            snapshot.write_text(json.dumps({"project": "site", "issues": [{"id": "7"}]}))
            reported = subprocess.run(
                [
                    sys.executable, str(script), "history",
                    "--snapshot", str(snapshot),
                    "--history", str(history),
                ],
                capture_output=True, check=False, text=True,
            )
            self.assertEqual(reported.returncode, 0, reported.stderr)
            payload = json.loads(reported.stdout)
            self.assertEqual(payload["counts"]["unclosed"], 1)
            self.assertEqual(payload["issues"]["7"]["prior_disposition"], "fixed")

    def test_record_refuses_an_incomplete_ledger(self):
        script = Path(__file__).with_name("ledger.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ledger.write_ledger(root / "ledger.tsv", [ledger_row("7", "")])
            recorded = subprocess.run(
                [
                    sys.executable, str(script), "record",
                    "--ledger", str(root / "ledger.tsv"),
                    "--run-id", "run-A",
                    "--run-date", "2026-08-16",
                    "--history", str(root / "history.tsv"),
                ],
                capture_output=True, check=False, text=True,
            )
            self.assertEqual(recorded.returncode, 1)
            self.assertIn("7", recorded.stderr)


if __name__ == "__main__":
    unittest.main()
