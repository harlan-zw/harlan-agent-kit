#!/usr/bin/env python3

import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class LedgerTest(unittest.TestCase):
    def test_init_and_audit_cover_exact_manifest_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for issue_id in ("1", "2"):
                (root / f"{issue_id}.json").write_text(
                    json.dumps(
                        {
                            "project": "site",
                            "issue": {"id": issue_id, "short_id": f"SITE-{issue_id}"},
                        }
                    )
                )
            manifest = root / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "project": "site",
                        "completed": {"1": "checksum-1", "2": "checksum-2"},
                    }
                )
            )
            ledger = root / "ledger.tsv"
            script = Path(__file__).with_name("ledger.py")
            initialized = subprocess.run(
                [
                    sys.executable,
                    str(script),
                    "init",
                    "--manifest",
                    str(manifest),
                    "--output",
                    str(ledger),
                ],
                capture_output=True,
                check=False,
                text=True,
            )
            self.assertEqual(initialized.returncode, 0, initialized.stderr)
            with ledger.open(newline="") as file:
                rows = list(csv.DictReader(file, delimiter="\t"))
            rows[0].update(
                root_cause="root",
                disposition="fixed",
                owning_fix="test and patch",
                evidence="event stack",
            )
            rows[1].update(
                root_cause="same root",
                disposition="covered",
                owning_issue="1",
                owning_fix="test and patch",
                evidence="same stack and release",
            )
            with ledger.open("w", newline="") as file:
                writer = csv.DictWriter(file, fieldnames=rows[0], delimiter="\t")
                writer.writeheader()
                writer.writerows(rows)
            audited = subprocess.run(
                [
                    sys.executable,
                    str(script),
                    "audit",
                    "--manifest",
                    str(manifest),
                    "--ledger",
                    str(ledger),
                ],
                capture_output=True,
                check=False,
                text=True,
            )
            self.assertEqual(audited.returncode, 0, audited.stderr)
            self.assertEqual(json.loads(audited.stdout)["rows"], 2)

            with ledger.open("w", newline="") as file:
                writer = csv.DictWriter(file, fieldnames=rows[0], delimiter="\t")
                writer.writeheader()
                writer.writerow(rows[0])
            incomplete = subprocess.run(
                [
                    sys.executable,
                    str(script),
                    "audit",
                    "--manifest",
                    str(manifest),
                    "--ledger",
                    str(ledger),
                ],
                capture_output=True,
                check=False,
                text=True,
            )
            self.assertEqual(incomplete.returncode, 1)
            self.assertIn("missing IDs: 2", incomplete.stderr)


if __name__ == "__main__":
    unittest.main()
