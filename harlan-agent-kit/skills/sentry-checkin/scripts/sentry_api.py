#!/usr/bin/env python3
"""Snapshot with sentry-cli, fetch redacted issue evidence, resolve proven fixes.

Every command except resolve is read-only. Resolve writes only with --apply.
"""

import argparse
import configparser
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


DEFAULT_URL = "https://sentry.io"
PAGE_SIZE = 100
SAFETY_CAP = 10_000
RESOLVE_CAP = 200
SECRET_KEYS = {
    "authorization",
    "cookie",
    "cookies",
    "email",
    "ip",
    "ip_address",
    "password",
    "refresh_token",
    "secret",
    "token",
    "username",
}
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
QUERY_SECRET_RE = re.compile(
    r"([?&](?:api_?key|auth|code|email|password|secret|token)=)[^&#\s]+",
    re.IGNORECASE,
)


def stable_json(value):
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def sha256_text(value):
    return hashlib.sha256(value.encode()).hexdigest()


def issue_ids_checksum(issue_ids):
    """Digest a set of numeric issue IDs in one canonical order.

    ledger.py audit digests the same way, so a snapshot and the ledger built
    from it produce equal checksums whenever they cover equal ID sets.
    """
    return sha256_text("\n".join(sorted(set(issue_ids), key=int)) + "\n")


def load_cli_config():
    config = configparser.ConfigParser()
    config.read(Path.home() / ".sentryclirc")
    token = os.environ.get("SENTRY_AUTH_TOKEN") or config.get("auth", "token", fallback="")
    base_url = os.environ.get("SENTRY_URL") or config.get(
        "defaults", "url", fallback=DEFAULT_URL
    )
    if not token:
        raise RuntimeError(
            "Sentry authentication missing. Run sentry-cli login or set SENTRY_AUTH_TOKEN."
        )
    return token.strip(), base_url.rstrip("/")


def redact(value, key=""):
    if key.lower() in SECRET_KEYS:
        return "[REDACTED]"
    if isinstance(value, dict):
        return {item_key: redact(item, item_key) for item_key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        value = EMAIL_RE.sub("[REDACTED_EMAIL]", value)
        value = IP_RE.sub("[REDACTED_IP]", value)
        return QUERY_SECRET_RE.sub(r"\1[REDACTED]", value)
    return value


def sentry_cli_command():
    override = os.environ.get("SENTRY_CLI_COMMAND")
    if override:
        return shlex.split(override)
    executable = shutil.which("sentry-cli")
    if executable:
        return [executable]
    return ["pnpm", "dlx", "@sentry/cli"]


def parse_cli_table(output):
    if "No issues found" in output:
        return []
    lines = output.splitlines()
    header_index = next(
        (
            index
            for index, line in enumerate(lines)
            if line.startswith("|") and "Issue ID" in line and "Short ID" in line
        ),
        None,
    )
    if header_index is None:
        raise RuntimeError("Could not parse sentry-cli issue table.")
    header = lines[header_index]
    separators = [index for index, character in enumerate(header) if character == "|"]
    columns = [
        header[separators[index] + 1 : separators[index + 1]].strip()
        for index in range(len(separators) - 1)
    ]
    issues = []
    for line in lines[header_index + 1 :]:
        if not line.startswith("|"):
            continue
        if len(line) <= separators[-1]:
            raise RuntimeError("Malformed sentry-cli issue row.")
        values = [
            line[separators[index] + 1 : separators[index + 1]].strip()
            for index in range(len(separators) - 1)
        ]
        row = dict(zip(columns, values))
        issue_id = row.get("Issue ID", "")
        if not issue_id.isdigit():
            continue
        title = row.get("Title", "")
        issues.append(
            {
                "id": issue_id,
                "short_id": row.get("Short ID"),
                "title_hint": title,
                "title_truncated": title.endswith("..."),
                "last_seen": row.get("Last seen"),
                "status": row.get("Status"),
                "level": row.get("Level"),
            }
        )
    return issues


def snapshot_issues(args):
    command = sentry_cli_command() + [
        "issues",
        "list",
        "--org",
        args.org,
        "--project",
        args.project,
        "--query",
        args.query,
        "--pages",
        "100",
        "--max-rows",
        str(SAFETY_CAP),
    ]
    result = subprocess.run(command, capture_output=True, check=False, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "sentry-cli issue snapshot failed.")
    issues = parse_cli_table(result.stdout)
    if len(issues) >= SAFETY_CAP:
        raise RuntimeError(
            f"Snapshot reached {SAFETY_CAP} rows; refusing possibly truncated discovery."
        )
    # sentry-cli paginates a live query, so an issue whose rank shifts between
    # page requests can appear twice. Downstream bulk-bundles and ledger init
    # both reject duplicates, so keep the first row per ID and name the drop.
    unique = {}
    duplicates = []
    for issue in issues:
        if issue["id"] in unique:
            duplicates.append(issue["id"])
            continue
        unique[issue["id"]] = issue
    issues = sorted(unique.values(), key=lambda issue: int(issue["id"]))
    snapshot = {
        "source": "sentry-cli",
        "org": args.org,
        "project": args.project,
        "query": args.query,
        "issue_count": len(issues),
        "issue_ids_sha256": issue_ids_checksum(unique),
        "duplicate_ids_dropped": sorted(set(duplicates), key=int),
        "issues": issues,
    }
    output = stable_json(snapshot)
    if args.output:
        path = Path(args.output)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(output)
    return snapshot


def next_cursor(link_header):
    if not link_header:
        return None
    for part in link_header.split(","):
        if 'rel="next"' not in part or 'results="true"' not in part:
            continue
        match = re.search(r'cursor="([^"]+)"', part)
        if match:
            return match.group(1)
    return None


def request_json(base_url, token, path, params=None):
    url = f"{base_url}{path}"
    if params:
        url = f"{url}?{urlencode(params, doseq=True)}"
    request = Request(
        url,
        headers={"Accept": "application/json", "Authorization": f"Bearer {token}"},
    )
    for attempt in range(3):
        try:
            with urlopen(request, timeout=30) as response:
                body = response.read().decode("utf-8")
                return (json.loads(body) if body else None), response.headers
        except HTTPError as error:
            body = error.read().decode("utf-8", "ignore")
            if attempt < 2 and (error.code == 429 or error.code >= 500):
                time.sleep(attempt + 1)
                continue
            raise RuntimeError(f"Sentry returned HTTP {error.code}: {body}") from error
        except URLError as error:
            if attempt < 2:
                time.sleep(attempt + 1)
                continue
            raise RuntimeError(f"Sentry network error: {error.reason}") from error
    raise RuntimeError("Sentry request retry loop ended unexpectedly.")


def paged_get(
    base_url, token, path, params=None, limit=SAFETY_CAP, require_complete=True
):
    items = []
    cursor = None
    while True:
        page_params = dict(params or {})
        page_params["per_page"] = min(PAGE_SIZE, limit - len(items))
        if cursor:
            page_params["cursor"] = cursor
        data, headers = request_json(base_url, token, path, page_params)
        if not data:
            return items
        items.extend(data)
        cursor = next_cursor(headers.get("Link"))
        if not cursor:
            return items
        if len(items) >= limit:
            if require_complete:
                raise RuntimeError(
                    f"Result exceeded safety cap {limit}; refusing incomplete discovery."
                )
            return items[:limit]


def issue_summary(issue):
    return {
        "id": issue.get("id"),
        "short_id": issue.get("shortId"),
        "title": issue.get("title"),
        "culprit": issue.get("culprit"),
        "level": issue.get("level"),
        "status": issue.get("status"),
        "count": issue.get("count"),
        "first_seen": issue.get("firstSeen"),
        "last_seen": issue.get("lastSeen"),
        "permalink": issue.get("permalink"),
    }


def compact_frame(frame):
    keys = (
        "filename",
        "abs_path",
        "module",
        "function",
        "lineno",
        "colno",
        "in_app",
        "context_line",
        "pre_context",
        "post_context",
    )
    return {key: frame.get(key) for key in keys if frame.get(key) is not None}


def compact_event(event):
    exceptions = []
    breadcrumbs = []
    request = event.get("request")
    for entry in event.get("entries", []):
        entry_type = entry.get("type")
        data = entry.get("data") or {}
        if entry_type == "exception":
            for exception in data.get("values") or []:
                stacktrace = exception.get("stacktrace") or {}
                exceptions.append(
                    {
                        "type": exception.get("type"),
                        "value": exception.get("value"),
                        "mechanism": exception.get("mechanism"),
                        "frames": [
                            compact_frame(frame)
                            for frame in stacktrace.get("frames") or []
                        ],
                    }
                )
        elif entry_type == "breadcrumbs":
            breadcrumbs = (data.get("values") or [])[-50:]
        elif entry_type == "request" and not request:
            request = data
    keys = (
        "eventID",
        "dateCreated",
        "title",
        "message",
        "culprit",
        "platform",
        "environment",
        "release",
        "tags",
        "contexts",
    )
    compact = {key: event.get(key) for key in keys if event.get(key) is not None}
    compact.update(
        {"request": request, "exceptions": exceptions, "breadcrumbs": breadcrumbs}
    )
    return compact


def fetch_issue_bundle(org, project, issue_id, events, compact, base_url, token):
    issue, _ = request_json(
        base_url, token, f"/api/0/organizations/{org}/issues/{issue_id}/"
    )
    event_rows = paged_get(
        base_url,
        token,
        f"/api/0/organizations/{org}/issues/{issue_id}/events/",
        limit=events,
        require_complete=False,
    )
    detailed_events = []
    for event in event_rows:
        event_id = event.get("eventID") or event.get("id")
        if not event_id:
            continue
        detail, _ = request_json(
            base_url,
            token,
            f"/api/0/projects/{org}/{project}/events/{event_id}/",
        )
        detailed_events.append(compact_event(detail) if compact else detail)
    return {
        "project": project,
        "issue": issue_summary(issue) if compact else issue,
        "events": detailed_events,
    }


def issue_bundle(args, base_url, token):
    return fetch_issue_bundle(
        args.org,
        args.project,
        args.issue,
        args.events,
        args.compact,
        base_url,
        token,
    )


def bulk_bundles(args, base_url, token):
    snapshot_path = Path(args.snapshot)
    snapshot_text = snapshot_path.read_text()
    snapshot = json.loads(snapshot_text)
    if snapshot.get("org") != args.org or snapshot.get("project") != args.project:
        raise RuntimeError("Snapshot organization or project does not match arguments.")
    issue_ids = [issue.get("id") for issue in snapshot.get("issues", [])]
    if any(not isinstance(issue_id, str) or not issue_id.isdigit() for issue_id in issue_ids):
        raise RuntimeError("Snapshot contains an invalid numeric issue ID.")
    if len(issue_ids) != len(set(issue_ids)):
        raise RuntimeError("Snapshot contains duplicate issue IDs.")
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    checksums = {}
    errors = {}

    def fetch(issue_id):
        path = output_dir / f"{issue_id}.json"
        if path.exists():
            existing = json.loads(path.read_text())
            if str(existing.get("issue", {}).get("id")) == issue_id:
                text = stable_json(existing)
                return issue_id, text
        value = fetch_issue_bundle(
            args.org,
            args.project,
            issue_id,
            args.events,
            True,
            base_url,
            token,
        )
        text = stable_json(redact(value))
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(text)
        temporary.replace(path)
        return issue_id, text

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(fetch, issue_id): issue_id for issue_id in issue_ids}
        for future in as_completed(futures):
            issue_id = futures[future]
            try:
                completed_id, text = future.result()
                checksums[completed_id] = sha256_text(text)
            except Exception as error:
                errors[issue_id] = str(error)
    manifest = {
        "source_snapshot": str(snapshot_path.resolve()),
        "snapshot_sha256": sha256_text(snapshot_text),
        "org": args.org,
        "project": args.project,
        "issue_count": len(issue_ids),
        "issue_ids_sha256": issue_ids_checksum(issue_ids),
        "events_per_issue": args.events,
        "completed": dict(sorted(checksums.items())),
        "errors": dict(sorted(errors.items())),
    }
    manifest_text = stable_json(manifest)
    (output_dir / "manifest.json").write_text(manifest_text)
    if errors:
        raise RuntimeError(
            f"Evidence fetch failed for {len(errors)} issues; rerun to resume."
        )
    return manifest


def request_write(base_url, token, path, payload, params=None, method="PUT"):
    url = f"{base_url}{path}"
    if params:
        url = f"{url}?{urlencode(params, doseq=True)}"
    request = Request(
        url,
        data=json.dumps(payload).encode(),
        method=method,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    for attempt in range(3):
        try:
            with urlopen(request, timeout=30) as response:
                body = response.read().decode("utf-8")
                return json.loads(body) if body else None
        except HTTPError as error:
            body = error.read().decode("utf-8", "ignore")
            if attempt < 2 and (error.code == 429 or error.code >= 500):
                time.sleep(attempt + 1)
                continue
            raise RuntimeError(f"Sentry returned HTTP {error.code}: {body}") from error
        except URLError as error:
            if attempt < 2:
                time.sleep(attempt + 1)
                continue
            raise RuntimeError(f"Sentry network error: {error.reason}") from error
    raise RuntimeError("Sentry write retry loop ended unexpectedly.")


def resolve_release_target(org, project, version, base_url, token):
    """Reject a release that Sentry does not hold for this project.

    A local build with an auth token can create a release that was never
    deployed, so an unchecked version silently resolves against nothing.
    """
    data, _ = request_json(
        base_url, token, f"/api/0/organizations/{org}/releases/{quote(version, safe='')}/"
    )
    slugs = {entry.get("slug") for entry in (data or {}).get("projects") or []}
    if project not in slugs:
        raise RuntimeError(
            f"Release {version} is not associated with project {project}."
        )
    return {"version": version, "released": (data or {}).get("dateReleased")}


def resolve_issues(args, base_url, token):
    issue_ids = [str(value) for value in args.issue]
    if len(issue_ids) != len(set(issue_ids)):
        raise RuntimeError("Repeated --issue value.")
    if any(not value.isdigit() for value in issue_ids):
        raise RuntimeError("Every --issue must be a numeric issue ID.")
    if len(issue_ids) > RESOLVE_CAP:
        raise RuntimeError(f"Refusing to resolve more than {RESOLVE_CAP} issues at once.")
    if args.in_release:
        release = resolve_release_target(
            args.org, args.project, args.in_release, base_url, token
        )
        status_details = {"inRelease": args.in_release}
    else:
        release = None
        status_details = {"inNextRelease": True}
    before = {}
    for issue_id in issue_ids:
        data, _ = request_json(
            base_url, token, f"/api/0/organizations/{args.org}/issues/{issue_id}/"
        )
        issue_project = ((data or {}).get("project") or {}).get("slug")
        if issue_project is not None and issue_project != args.project:
            raise RuntimeError(
                f"Issue {issue_id} does not belong to project {args.project}."
            )
        before[issue_id] = {
            "short_id": (data or {}).get("shortId"),
            "status": (data or {}).get("status"),
        }
    already = sorted(key for key, value in before.items() if value["status"] == "resolved")
    pending = [issue_id for issue_id in issue_ids if issue_id not in set(already)]
    result = {
        "org": args.org,
        "project": args.project,
        "mode": "in-release" if args.in_release else "in-next-release",
        "release": release,
        "issues": dict(sorted(before.items())),
        "already_resolved": already,
        "would_resolve": sorted(pending, key=int),
        "applied": False,
    }
    if not args.apply:
        return result
    if not pending:
        result["applied"] = True
        return result
    request_write(
        base_url,
        token,
        f"/api/0/projects/{args.org}/{args.project}/issues/",
        {"status": "resolved", "statusDetails": status_details},
        params={"id": pending},
    )
    result["applied"] = True
    result["resolved"] = sorted(pending, key=int)
    return result


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--org", required=True, help="Sentry organization slug")
    subparsers = parser.add_subparsers(dest="command", required=True)

    snapshot = subparsers.add_parser(
        "snapshot", help="Create a JSON snapshot by invoking sentry-cli"
    )
    snapshot.add_argument("--project", required=True)
    snapshot.add_argument("--query", default="is:unresolved")
    snapshot.add_argument("--output")

    bundle = subparsers.add_parser("bundle", help="Fetch issue and recent full events")
    bundle.add_argument("--project", required=True)
    bundle.add_argument("--issue", required=True)
    bundle.add_argument("--events", type=int, default=1)
    bundle.add_argument("--compact", action="store_true")

    bulk = subparsers.add_parser(
        "bulk-bundles", help="Fetch compact evidence for every snapshot issue"
    )
    bulk.add_argument("--project", required=True)
    bulk.add_argument("--snapshot", required=True)
    bulk.add_argument("--output", required=True)
    bulk.add_argument("--events", type=int, default=1)
    bulk.add_argument("--workers", type=int, default=4)

    resolve = subparsers.add_parser(
        "resolve", help="Resolve issues this run proved fixed"
    )
    resolve.add_argument("--project", required=True)
    resolve.add_argument("--issue", required=True, action="append")
    mode = resolve.add_mutually_exclusive_group(required=True)
    mode.add_argument("--in-next-release", action="store_true")
    mode.add_argument("--in-release")
    resolve.add_argument(
        "--apply",
        action="store_true",
        help="Perform the write. Without it the command only reports the plan.",
    )
    return parser


def main():
    args = build_parser().parse_args()
    if getattr(args, "events", 1) < 1 or getattr(args, "events", 1) > 20:
        raise RuntimeError("--events must be between 1 and 20.")
    if getattr(args, "workers", 1) < 1 or getattr(args, "workers", 1) > 8:
        raise RuntimeError("--workers must be between 1 and 8.")
    if args.command == "snapshot":
        result = snapshot_issues(args)
    else:
        token, base_url = load_cli_config()
        if args.command == "bundle":
            result = issue_bundle(args, base_url, token)
        elif args.command == "resolve":
            result = resolve_issues(args, base_url, token)
        else:
            result = bulk_bundles(args, base_url, token)
    print(stable_json(redact(result)), end="")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
