#!/usr/bin/env python3
"""Export compact Agent transcripts from opencode.db grouped by goal, joined to the journal.

Run on Hogwild. Reads both databases read-only.

Usage: export-sessions.py OUT_DIR [--days 7] [--per-goal 10] [--redact-env-file PATH ...]
"""
import collections
import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from functools import cache

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('out')
parser.add_argument('--days', type=int, default=7)
parser.add_argument('--per-goal', type=int, default=10)
parser.add_argument('--redact-env-file', action='append', default=[], metavar='PATH')
args = parser.parse_args()
out, days, per_goal = args.out, args.days, args.per_goal

SENSITIVE_KEY = re.compile(r'token|secret|password|api_?key|private_?key', re.I)


def load_secret_values(paths):
    """Read explicit single-line dotenv sources. Never include values in errors."""
    values = set()
    for path in paths:
        with open(path) as source:
            for number, line in enumerate(source, 1):
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                assignment = re.fullmatch(r'(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)', line)
                if assignment is None:
                    raise ValueError(f'Invalid environment assignment in {path}, line {number}.')
                key, value = assignment.groups()
                if not SENSITIVE_KEY.search(key):
                    continue
                if value.startswith(('"', "'")):
                    quoted = re.fullmatch(r'(["\'])(.*?)\1\s*(?:#.*)?', value)
                    if quoted is None:
                        raise ValueError(f'Invalid secret assignment in {path}, line {number}. Use single-line values.')
                    value = quoted.group(2)
                    if quoted.group(1) == '"':
                        try:
                            value = json.loads('"' + value + '"')
                        except json.JSONDecodeError:
                            raise ValueError(f'Invalid quoted secret in {path}, line {number}.') from None
                else:
                    value = re.split(r'\s+#', value, maxsplit=1)[0].rstrip()
                if value:
                    values.add(value)
    return sorted(values, key=len, reverse=True)


# A missing or malformed source stops before any artifact is written.
KNOWN_SECRETS = load_secret_values(args.redact_env_file)

OPENCODE_DB = os.path.expanduser('~/.local/share/opencode/opencode.db')
JOURNAL_DB = os.path.expanduser('~/.local/share/harlan-github-agent/state.sqlite')


def open_readonly(path):
    con = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    return con


con = open_readonly(OPENCODE_DB)
journal = open_readonly(JOURNAL_DB) if os.path.exists(JOURNAL_DB) else None
since = int((time.time() - days * 86400) * 1000)

# Worktree slug -> goal. The controller names each worktree after its role.
GOALS = [
    ('adversarial_review', r'\.harlan-agent-review-'),
    ('review_fix', r'\.harlan-agent-fix-'),
    ('resolve_conflict', r'\.harlan-agent-pull-'),
    ('baseline_repair', r'\.harlan-agent-baseline-'),
    ('issue', r'\.harlan-agent-issue-'),
    ('routine', r'\.harlan-agent-routine-'),
    ('pull_request_triage', r'harlan-github-agent/worktrees$'),
]
TASK_KIND = {'review_fix': 'review_fix', 'resolve_conflict': 'resolve_conflict', 'baseline_repair': 'baseline_repair'}

SLUG = re.compile(r'\.harlan-agent-(?:review|fix|pull|baseline|issue|routine)-(?P<number>[^-]+)-(?P<revision>[0-9a-f]{12})')
BASELINE_SLUG = re.compile(r'\.harlan-agent-baseline-(?P<base>[0-9a-f]{12})-(?P<lease>[0-9a-f]{12})(?:$|/)')
TASK_LEASE_SLUG = re.compile(r'\.harlan-agent-(?:fix|pull|baseline)-[^/]+-(?P<lease>[0-9a-f]{12})(?:$|/)')

# Transcripts carry raw shell output. Redact token shapes before anything reads them.
SECRETS = [
    (re.compile(r'((?:token|secret|password|api_key|apikey|private_key)"\s*:\s*)"(?:\\.|[^"\\])*"', re.I), r'\1"***"'),
    (re.compile(r'(x-access-token:)[^@\s]+(@)', re.I), r'\1***\2'),
    (re.compile(r'\b(gh[pousr]_)[A-Za-z0-9]{16,}\b'), r'\1***'),
    (re.compile(r'\b(github_pat_)\w{16,}\b'), r'\1***'),
    (re.compile(r'\b(sk-)[\w-]{16,}\b'), r'\1***'),
    (re.compile(r'\b(sntry[su]_)[\w-]{16,}\b'), r'\1***'),
    (re.compile(r'(Bearer\s+)[\w.-]{16,}\b', re.I), r'\1***'),
    (re.compile(r'((?:token|secret|password|api_key|apikey)["\']?\s*[=:]\s*["\']?)[\w./+=-]{1,}', re.I), r'\1***'),
]


def redact(s):
    for value in KNOWN_SECRETS:
        s = s.replace(value, '***')
        # Index JSON escapes quotes and newlines in titles and journal reasons.
        s = s.replace(json.dumps(value)[1:-1], '***')
    for pat, rep in SECRETS:
        s = pat.sub(rep, s)
    return s


def redact_data(value):
    """Redact parsed fields before serialization or presentation changes."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {
            redact(key): '***' if SENSITIVE_KEY.search(key) and isinstance(item, str) else redact_data(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_data(item) for item in value]
    return value


def goal_of(directory):
    for g, pat in GOALS:
        if re.search(pat, directory):
            return g
    return 'other'


def subject_of(directory):
    baseline = BASELINE_SLUG.search(directory)
    if baseline:
        return baseline.group('base')
    m = SLUG.search(directory)
    return f"{m.group('number')}-{m.group('revision')}" if m else directory


@cache
def tasks_by_lease():
    """Task worktree suffixes name exact leases, including Logged finding Repairs."""
    if journal is None:
        return {}
    tasks = {}
    for row in journal.execute('select id, kind, fence from tasks'):
        for fence in range(1, row['fence'] + 1):
            key = hashlib.sha256(f"{row['id']}:{fence}".encode()).hexdigest()[:12]
            tasks[(row['kind'], key)] = row['id']
    return tasks


def trunc(s, n):
    s = redact(s or '')
    return s if len(s) <= n else s[:n] + f'… [+{len(s) - n} chars]'


def summarize_input(tool, inp):
    if tool == 'bash':
        return inp.get('command', '')
    if tool == 'read':
        return f"{inp.get('filePath', '')} offset={inp.get('offset')} limit={inp.get('limit')}"
    if tool in ('edit', 'write'):
        return inp.get('filePath', '')
    if tool == 'grep':
        return f"pattern={inp.get('pattern')} path={inp.get('path')} include={inp.get('include')}"
    if tool == 'glob':
        return f"pattern={inp.get('pattern')} path={inp.get('path')}"
    if tool == 'skill':
        return inp.get('name', json.dumps(inp)[:200])
    return json.dumps(inp)[:300]


def journal_outcome(goal, sess):
    """Joins one session to the journal row that owned it. Returns a dict or None."""
    if journal is None:
        return None
    if goal == 'adversarial_review':
        row = journal.execute(
            'select outcome_tag, confidence, findings, completed_at from review_runs where session_id = ?', (sess['id'],),
        ).fetchone()
        if row:
            return dict(source='review_runs', outcome=row['outcome_tag'], confidence=row['confidence'], findings=len(json.loads(row['findings'])), completed_at=row['completed_at'])
        return dict(source='review_runs', outcome='no review run recorded for this session')
    m = SLUG.search(sess['directory'])
    if not m:
        return None
    lease = TASK_LEASE_SLUG.search(sess['directory'])
    kind = TASK_KIND.get(goal)
    if goal == 'issue':
        row = journal.execute(
            'select id, state_tag, reason, attempts from worker_tasks where kind = ? and revision_id like ? order by updated_at desc limit 1',
            ('issue_triage', m.group('revision') + '%'),
        ).fetchone()
        if row is None:
            kind = 'issue_work'
        else:
            return dict(source='worker_tasks', task=row['id'][:12], state=row['state_tag'], reason=row['reason'], attempts=row['attempts'])
    if kind is None:
        return None
    if lease:
        task_id = tasks_by_lease().get((kind, lease.group('lease')))
        row = journal.execute(
            'select id, state_tag, reason, attempts, recovery_attempts, fence from tasks where kind = ? and id = ?',
            (kind, task_id),
        ).fetchone()
    else:
        row = journal.execute(
            'select id, state_tag, reason, attempts, recovery_attempts, fence from tasks where kind = ? and revision_id like ? order by updated_at desc limit 1',
            (kind, m.group('revision') + '%'),
        ).fetchone()
    if row is None:
        return dict(source='tasks', outcome='no task row for this worktree')
    transitions = journal.execute(
        'select to_tag, reason from task_transitions where task_id = ? order by created_at desc limit 3', (row['id'],),
    ).fetchall()
    task_label = row['id'] if row['id'].startswith('logged-finding:') else row['id'][:12]
    return dict(source='tasks', task=task_label, state=row['state_tag'], reason=row['reason'], attempts=row['attempts'], recovery_attempts=row['recovery_attempts'], fence=row['fence'], last_transitions=[f"{t['to_tag']}: {t['reason']}" for t in transitions])


def render(goal, sess):
    parts = con.execute(
        'select p.data, p.time_created, m.data as mdata from part p join message m on m.id=p.message_id where p.session_id=? order by p.time_created, p.id',
        (sess['id'],),
    ).fetchall()
    lines = []
    dur = (sess['time_updated'] - sess['time_created']) / 1000
    outcome = journal_outcome(goal, sess)
    lines.append(f"# session {sess['id']}")
    lines.append(f"title: {sess['title']}")
    lines.append(f"directory: {sess['directory']}")
    lines.append(f"model: {sess['model']}")
    lines.append(f"started: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(sess['time_created'] / 1000))} duration_min: {dur / 60:.1f}")
    lines.append(f"tokens: input={sess['tokens_input']} output={sess['tokens_output']} reasoning={sess['tokens_reasoning']} cache_read={sess['tokens_cache_read']}")
    lines.append(f"journal: {json.dumps(outcome)}")
    tool_counts = collections.Counter()
    tool_seconds = collections.Counter()
    cmd_counts = collections.Counter()
    edits = set()
    t0 = sess['time_created']
    user_prompt_done = False
    last_kind = 'none'
    body = []
    for p in parts:
        # Redact complete input and output before summaries, line selection,
        # or whitespace changes can split a known secret into fragments.
        d = redact_data(json.loads(p['data']))
        m = json.loads(p['mdata'])
        role = m.get('role')
        t = (p['time_created'] - t0) / 1000
        ts = f"[{t / 60:6.1f}m]"
        typ = d.get('type')
        if typ == 'text':
            if role == 'user':
                if not user_prompt_done:
                    body.append(f"{ts} USER PROMPT:\n" + trunc(d.get('text', ''), 6000))
                    user_prompt_done = True
                else:
                    body.append(f"{ts} USER: " + trunc(d.get('text', ''), 800))
                last_kind = 'user'
            else:
                body.append(f"{ts} ASSISTANT: " + trunc(d.get('text', ''), 1500))
                last_kind = 'assistant'
        elif typ == 'reasoning':
            body.append(f"{ts} think: " + trunc(d.get('text', '').replace('\n', ' '), 300))
            last_kind = 'reasoning'
        elif typ == 'tool':
            tool = d.get('tool')
            st = d.get('state', {}) or {}
            inp = st.get('input', {}) or {}
            tool_counts[tool] += 1
            summ = summarize_input(tool, inp)
            if tool == 'bash':
                cmd_counts[summ.strip()] += 1
            if tool in ('edit', 'write'):
                edits.add(inp.get('filePath', ''))
            outp = st.get('output', '') or ''
            status = st.get('status')
            err = st.get('error')
            meta = st.get('metadata', {}) or {}
            exit_code = meta.get('exit') if isinstance(meta, dict) else None
            timing = st.get('time') or {}
            secs = (timing.get('end', 0) - timing.get('start', 0)) / 1000 if timing.get('end') and timing.get('start') else None
            if secs is not None:
                tool_seconds[tool] += secs
            head = f"{ts} TOOL {tool} ({status}{'' if exit_code is None else f' exit={exit_code}'}{'' if secs is None else f' {secs:.0f}s'}): {trunc(summ, 400)}"
            body.append(head)
            if err:
                body.append(f"    ERROR: {trunc(str(err), 300)}")
            if outp and tool != 'read':
                tail = outp.strip().splitlines()
                tail = tail[-8:] if len(tail) > 8 else tail
                body.append('    out> ' + trunc(' | '.join(tail), 600))
            elif tool == 'read':
                body.append(f"    out> {len(outp)} chars")
            last_kind = f"tool {tool} {status}"
        elif typ == 'patch':
            body.append(f"{ts} PATCH files={d.get('files')}")
            last_kind = 'patch'
    end_reason = 'answered' if last_kind == 'assistant' else f'ended on {last_kind} (still running at export, killed, or provider error; see journal)'
    lines.append(f"end_reason: {end_reason}")
    lines.append('')
    lines.extend(body)
    lines.append('')
    lines.append('## summary')
    lines.append('tools: ' + json.dumps(tool_counts))
    lines.append('tool_seconds: ' + json.dumps({k: round(v) for k, v in tool_seconds.items()}))
    dup = {c: n for c, n in cmd_counts.items() if n > 1}
    if dup:
        lines.append('repeated bash commands: ' + json.dumps(dup)[:2000])
    if edits:
        lines.append('edited files: ' + json.dumps(sorted(edits)))
    return redact('\n'.join(lines)), dict(tools=dict(tool_counts), tool_seconds={k: round(v) for k, v in tool_seconds.items()}, duration_min=round(dur / 60, 1), end_reason=end_reason, journal=outcome)


sessions = con.execute('select * from session where time_created > ? and parent_id is null order by time_created desc', (since,)).fetchall()
groups = collections.defaultdict(list)
for s in sessions:
    groups[goal_of(s['directory'])].append(s)

index = []
for goal, ss in groups.items():
    gdir = os.path.join(out, goal)
    os.makedirs(gdir, exist_ok=True)
    by_subject = collections.defaultdict(list)
    for s in ss:
        by_subject[subject_of(s['directory'])].append(s)
    # Spread the sample: at most two per subject before filling from the rest.
    picked = []
    # A large loop may be older than the newest ten subjects. Always inspect it.
    largest = max(by_subject.values(), key=len)
    if len(largest) > 5:
        picked.append(max(largest, key=lambda session: session['time_updated'] - session['time_created']))
    for round_ in range(3):
        for lst in by_subject.values():
            if round_ < len(lst) and lst[round_] not in picked and len(picked) < per_goal:
                picked.append(lst[round_])
    picked = picked[:per_goal]
    stats = []
    for s in picked:
        text, meta = render(goal, s)
        with open(os.path.join(gdir, f"{s['id']}.md"), 'w') as f:
            f.write(text)
        model = json.loads(s['model'] or '{}')
        stats.append(dict(id=s['id'], title=s['title'], subject=subject_of(s['directory']), model=model.get('id'), tokens_in=s['tokens_input'], tokens_out=s['tokens_output'], reasoning=s['tokens_reasoning'], cache_read=s['tokens_cache_read'], **meta))
    repeats = {k: len(v) for k, v in by_subject.items() if len(v) > 1}
    with open(os.path.join(gdir, 'INDEX.md'), 'w') as f:
        f.write(f"# {goal}: {len(ss)} sessions in last {days} days, {len(picked)} exported\n\n")
        if repeats:
            f.write('subjects with repeated sessions (subject: count): ' + json.dumps(dict(sorted(repeats.items(), key=lambda kv: -kv[1]))) + '\n\n')
        for st in stats:
            f.write(redact(json.dumps(redact_data(st))) + '\n')
    index.append((goal, len(ss), len(picked), repeats))

with open(os.path.join(out, 'INDEX.md'), 'w') as f:
    f.write(f"window: last {days} days, sessions total: {len(sessions)}, journal joined: {journal is not None}\n")
    for goal, n, k, repeats in sorted(index, key=lambda r: -r[1]):
        top = max(repeats.values()) if repeats else 0
        f.write(f"- {goal}: {n} sessions, {k} exported, repeated subjects: {len(repeats)} (max {top})\n")
print(open(os.path.join(out, 'INDEX.md')).read())
