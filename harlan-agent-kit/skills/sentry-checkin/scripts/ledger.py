#!/usr/bin/env python3
"""Initialize and audit a Sentry check-in TSV ledger."""

import argparse
import csv
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path


FIELDS = (
    "numeric_id",
    "short_id",
    "project",
    "root_cause",
    "disposition",
    "owning_issue",
    "owning_fix",
    "evidence",
)
DISPOSITIONS = {
    "fixed",
    "covered",
    "already-fixed",
    "expected",
    "third-party",
    "blocked",
}


def load_manifest_rows(paths):
    rows = []
    for raw_path in paths:
        path = Path(raw_path)
        manifest = json.loads(path.read_text())
        project = manifest.get("project")
        for issue_id in manifest.get("completed", {}):
            bundle = json.loads((path.parent / f"{issue_id}.json").read_text())
            issue = bundle.get("issue", {})
            if str(issue.get("id")) != issue_id:
                raise RuntimeError(f"Bundle {issue_id} does not match its manifest.")
            rows.append(
                {
                    "numeric_id": issue_id,
                    "short_id": issue.get("short_id") or "",
                    "project": project or "",
                    "root_cause": "",
                    "disposition": "",
                    "owning_issue": "",
                    "owning_fix": "",
                    "evidence": "",
                }
            )
    ids = [row["numeric_id"] for row in rows]
    if len(ids) != len(set(ids)):
        raise RuntimeError("Manifests contain duplicate numeric issue IDs.")
    return sorted(rows, key=lambda row: int(row["numeric_id"]))


def write_ledger(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=FIELDS, delimiter="\t")
        writer.writeheader()
        writer.writerows(rows)


def read_ledger(path):
    with path.open(newline="") as file:
        reader = csv.DictReader(file, delimiter="\t")
        if tuple(reader.fieldnames or ()) != FIELDS:
            raise RuntimeError("Ledger header does not match the contract.")
        return list(reader)


def init_ledger(args):
    rows = load_manifest_rows(args.manifest)
    write_ledger(Path(args.output), rows)
    return {"rows": len(rows), "output": str(Path(args.output).resolve())}


def audit_ledger(args):
    expected = load_manifest_rows(args.manifest)
    actual = read_ledger(Path(args.ledger))
    expected_ids = {row["numeric_id"] for row in expected}
    actual_ids = [row["numeric_id"] for row in actual]
    if len(actual_ids) != len(set(actual_ids)):
        raise RuntimeError("Ledger contains duplicate numeric issue IDs.")
    missing = sorted(expected_ids - set(actual_ids), key=int)
    extra = sorted(set(actual_ids) - expected_ids, key=int)
    errors = []
    if missing:
        errors.append(f"missing IDs: {', '.join(missing)}")
    if extra:
        errors.append(f"extra IDs: {', '.join(extra)}")
    for row in actual:
        issue_id = row["numeric_id"]
        disposition = row["disposition"]
        if disposition not in DISPOSITIONS:
            errors.append(f"{issue_id}: invalid disposition {disposition!r}")
        if not row["root_cause"]:
            errors.append(f"{issue_id}: root_cause is empty")
        if not row["evidence"]:
            errors.append(f"{issue_id}: evidence is empty")
        if disposition == "fixed" and not row["owning_fix"]:
            errors.append(f"{issue_id}: fixed row lacks owning_fix")
        if disposition == "covered":
            if row["owning_issue"] not in expected_ids:
                errors.append(f"{issue_id}: covered row lacks a valid owning_issue")
            if not row["owning_fix"]:
                errors.append(f"{issue_id}: covered row lacks owning_fix")
    if errors:
        raise RuntimeError("Ledger audit failed: " + "; ".join(errors))
    content = Path(args.ledger).read_bytes()
    return {
        "rows": len(actual),
        "issue_ids_sha256": hashlib.sha256(
            ("\n".join(sorted(actual_ids, key=int)) + "\n").encode()
        ).hexdigest(),
        "ledger_sha256": hashlib.sha256(content).hexdigest(),
        "dispositions": dict(sorted(Counter(row["disposition"] for row in actual).items())),
    }


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    init = subparsers.add_parser("init")
    init.add_argument("--manifest", action="append", required=True)
    init.add_argument("--output", required=True)
    audit = subparsers.add_parser("audit")
    audit.add_argument("--manifest", action="append", required=True)
    audit.add_argument("--ledger", required=True)
    return parser


def main():
    args = build_parser().parse_args()
    result = init_ledger(args) if args.command == "init" else audit_ledger(args)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
