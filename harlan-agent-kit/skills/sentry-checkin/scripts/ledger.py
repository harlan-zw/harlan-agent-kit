#!/usr/bin/env python3
"""Initialize and audit a Sentry check-in TSV ledger."""

import argparse
import csv
import hashlib
import json
import os
import sys
from collections import Counter
from datetime import date
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
        # Same canonical order as sentry_api.issue_ids_checksum, so this value
        # is directly comparable with the frozen snapshot's checksum.
        "issue_ids_sha256": hashlib.sha256(
            ("\n".join(sorted(set(actual_ids), key=int)) + "\n").encode()
        ).hexdigest(),
        "ledger_sha256": hashlib.sha256(content).hexdigest(),
        "dispositions": dict(sorted(Counter(row["disposition"] for row in actual).items())),
    }


HISTORY_FIELDS = (
    "run_id",
    "run_date",
    "numeric_id",
    "short_id",
    "project",
    "disposition",
    "owning_fix",
    "root_cause",
)
# These dispositions claim the issue is closed in code. If a later snapshot
# still lists the issue, the claim never reached Sentry: either the release
# never resolved it or the fix does not hold. Re-proving the same commit is
# wasted work, so the site agent must answer why it stayed open instead.
CLOSING_DISPOSITIONS = {"fixed", "already-fixed"}


def default_history_path():
    state = os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state"
    return Path(state) / "sentry-checkin" / "history.tsv"


def history_rows_from_ledger(ledger_rows, run_id, run_date):
    """Project complete ledger rows into history rows. Raises on an incomplete ledger."""
    if not run_id:
        raise ValueError("run_id is required.")
    date.fromisoformat(run_date)
    rows = []
    for row in ledger_rows:
        disposition = row.get("disposition", "")
        if disposition not in DISPOSITIONS:
            raise RuntimeError(
                f"{row.get('numeric_id')}: cannot record disposition {disposition!r}"
            )
        rows.append(
            {
                "run_id": run_id,
                "run_date": run_date,
                "numeric_id": row["numeric_id"],
                "short_id": row.get("short_id", ""),
                "project": row.get("project", ""),
                "disposition": disposition,
                "owning_fix": row.get("owning_fix", ""),
                "root_cause": row.get("root_cause", ""),
            }
        )
    return rows


def read_history(path):
    path = Path(path)
    if not path.exists():
        return []
    with path.open(newline="") as file:
        reader = csv.DictReader(file, delimiter="\t")
        if tuple(reader.fieldnames or ()) != HISTORY_FIELDS:
            raise RuntimeError("History header does not match the contract.")
        return list(reader)


def append_history(path, rows):
    """Append rows not already recorded for their run. Returns the number written."""
    path = Path(path)
    existing = read_history(path)
    seen = {(row["run_id"], row["numeric_id"]) for row in existing}
    fresh = [row for row in rows if (row["run_id"], row["numeric_id"]) not in seen]
    if not fresh:
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=HISTORY_FIELDS, delimiter="\t")
        if not existing:
            writer.writeheader()
        writer.writerows(fresh)
    return len(fresh)


def latest_priors(history_rows):
    """The most recent history row per numeric ID, with how many runs saw it."""
    priors = {}
    for row in sorted(history_rows, key=lambda item: (item["run_date"], item["run_id"])):
        issue_id = row["numeric_id"]
        seen = priors[issue_id]["runs_seen"] + 1 if issue_id in priors else 1
        priors[issue_id] = {"row": row, "runs_seen": seen}
    return priors


def classify_snapshot(numeric_ids, history_rows, exclude_runs=frozenset()):
    """Tag every frozen ID as new, recurring, or regressed against prior runs.

    Pass the current run in exclude_runs so a re-read after `record` does not
    compare a run against itself.
    """
    priors = latest_priors(
        [row for row in history_rows if row["run_id"] not in exclude_runs]
    )
    classified = {}
    for issue_id in numeric_ids:
        prior = priors.get(str(issue_id))
        if prior is None:
            classified[str(issue_id)] = {
                "state": "new",
                "prior_disposition": None,
                "prior_run_id": None,
                "prior_run_date": None,
                "runs_seen": 0,
            }
            continue
        row = prior["row"]
        state = (
            "unclosed"
            if row["disposition"] in CLOSING_DISPOSITIONS
            else "recurring"
        )
        classified[str(issue_id)] = {
            "state": state,
            "prior_disposition": row["disposition"],
            "prior_run_id": row["run_id"],
            "prior_run_date": row["run_date"],
            "runs_seen": prior["runs_seen"],
        }
    return classified


def snapshot_ids(paths):
    ids = []
    for raw_path in paths:
        snapshot = json.loads(Path(raw_path).read_text())
        ids.extend(str(issue["id"]) for issue in snapshot.get("issues", []))
    return ids


def record_history(args):
    history_path = Path(args.history) if args.history else default_history_path()
    rows = []
    for raw_path in args.ledger:
        rows.extend(
            history_rows_from_ledger(
                read_ledger(Path(raw_path)), args.run_id, args.run_date
            )
        )
    appended = append_history(history_path, rows)
    return {
        "appended": appended,
        "skipped": len(rows) - appended,
        "rows_read": len(rows),
        "history": str(history_path.resolve()),
    }


def history_report(args):
    history_path = Path(args.history) if args.history else default_history_path()
    ids = snapshot_ids(args.snapshot)
    classified = classify_snapshot(
        ids, read_history(history_path), exclude_runs=set(args.exclude_run or ())
    )
    result = {
        "history": str(history_path.resolve()),
        "counts": dict(
            sorted(Counter(item["state"] for item in classified.values()).items())
        ),
        "issues": classified,
    }
    for state in ("new", "recurring", "unclosed"):
        result["counts"].setdefault(state, 0)
    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(json.dumps(result, indent=2, sort_keys=True))
    return result


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    init = subparsers.add_parser("init")
    init.add_argument("--manifest", action="append", required=True)
    init.add_argument("--output", required=True)
    audit = subparsers.add_parser("audit")
    audit.add_argument("--manifest", action="append", required=True)
    audit.add_argument("--ledger", required=True)
    record = subparsers.add_parser("record")
    record.add_argument("--ledger", action="append", required=True)
    record.add_argument("--run-id", required=True)
    record.add_argument("--run-date", required=True)
    record.add_argument("--history")
    history = subparsers.add_parser("history")
    history.add_argument("--snapshot", action="append", required=True)
    history.add_argument("--history")
    history.add_argument("--exclude-run", action="append")
    history.add_argument("--output")
    return parser


COMMANDS = {
    "init": init_ledger,
    "audit": audit_ledger,
    "record": record_history,
    "history": history_report,
}


def main():
    args = build_parser().parse_args()
    print(json.dumps(COMMANDS[args.command](args), indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
