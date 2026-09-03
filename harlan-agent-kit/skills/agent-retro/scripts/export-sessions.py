#!/usr/bin/env python3
"""Export compact Agent transcripts from opencode.db grouped by goal, joined to the journal.

Run on Hogwild. Reads both databases read-only.

Usage: export-sessions.py OUT_DIR [--days 7] [--per-goal 10]
"""
import collections
import json
import os
import re
import sqlite3
import sys
import time

out = sys.argv[1]
days = 7
per_goal = 10
args = sys.argv[2:]
for i, a in enumerate(args):
    if a == '--days':
        days = int(args[i + 1])
    if a == '--per-goal':
        per_goal = int(args[i + 1])

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

# Transcripts carry raw shell output. Redact token shapes before anything reads them.
SECRETS = [
    (re.compile(r'(x-access-token:)[^@\s]+(@)', re.I), r'\1***\2'),
    (re.compile(r'\b(gh[pousr]_)[A-Za-z0-9]{16,}\b'), r'\1***'),
    (re.compile(r'\b(github_pat_)\w{16,}\b'), r'\1***'),
    (re.compile(r'\b(sk-)[\w-]{16,}\b'), r'\1***'),
    (re.compile(r'\b(sntry[su]_)[\w-]{16,}\b'), r'\1***'),
    (re.compile(r'(Bearer\s+)[\w.-]{16,}\b', re.I), r'\1***'),
    (re.compile(r'((?:token|secret|password|api_key|apikey)\s*[=:]\s*["\']?)[\w.-]{16,}', re.I), r'\1***'),
]


def redact(s):
    for pat, rep in SECRETS:
        s = pat.sub(rep, s)
    return s


def goal_of(directory):
    for g, pat in GOALS:
        if re.search(pat, directory):
            return g
    return 'other'


def subject_of(directory):
    m = SLUG.search(directory)
    return f"{m.group('number')}-{m.group('revision')}" if m else directory


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
    row = journal.execute(
        'select id, state_tag, reason, attempts, recovery_attempts, fence from tasks where kind = ? and revision_id like ? order by updated_at desc limit 1',
        (kind, m.group('revision') + '%'),
    ).fetchone()
    if row is None:
        return dict(source='tasks', outcome='no task row for this revision')
    transitions = journal.execute(
        'select to_tag, reason from task_transitions where task_id = ? order by created_at desc limit 3', (row['id'],),
    ).fetchall()
    return dict(source='tasks', task=row['id'][:12], state=row['state_tag'], reason=row['reason'], attempts=row['attempts'], recovery_attempts=row['recovery_attempts'], fence=row['fence'], last_transitions=[f"{t['to_tag']}: {t['reason']}" for t in transitions])


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
        d = json.loads(p['data'])
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
    return '\n'.join(lines), dict(tools=dict(tool_counts), tool_seconds={k: round(v) for k, v in tool_seconds.items()}, duration_min=round(dur / 60, 1), end_reason=end_reason, journal=outcome)


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
    for round_ in range(3):
        for lst in by_subject.values():
            if round_ < len(lst) and len(picked) < per_goal:
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
            f.write(json.dumps(st) + '\n')
    index.append((goal, len(ss), len(picked), repeats))

with open(os.path.join(out, 'INDEX.md'), 'w') as f:
    f.write(f"window: last {days} days, sessions total: {len(sessions)}, journal joined: {journal is not None}\n")
    for goal, n, k, repeats in sorted(index, key=lambda r: -r[1]):
        top = max(repeats.values()) if repeats else 0
        f.write(f"- {goal}: {n} sessions, {k} exported, repeated subjects: {len(repeats)} (max {top})\n")
print(open(os.path.join(out, 'INDEX.md')).read())
