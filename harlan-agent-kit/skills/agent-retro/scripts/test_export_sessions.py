import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name('export-sessions.py')


class ExportSessionsTest(unittest.TestCase):
    def test_sample_includes_largest_repeat_even_when_older(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            opencode = home / '.local/share/opencode/opencode.db'
            opencode.parent.mkdir(parents=True)
            now = int(time.time() * 1000)
            with sqlite3.connect(opencode) as database:
                database.execute('''CREATE TABLE session (
                    id TEXT, title TEXT, directory TEXT, model TEXT,
                    time_created INTEGER, time_updated INTEGER, parent_id TEXT,
                    tokens_input INTEGER, tokens_output INTEGER,
                    tokens_reasoning INTEGER, tokens_cache_read INTEGER
                )''')
                database.execute('CREATE TABLE message (id TEXT, data TEXT)')
                database.execute('CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, data TEXT, time_created INTEGER)')
                for number in range(10):
                    database.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, NULL, 10, 2, 0, 0)', (
                        f'ses_recent_{number}', 'Recent review',
                        f'/tmp/repo.harlan-agent-review-{number}-{number:012x}-deadbeef1234',
                        '{"id":"fixture"}', now - number * 1000, now - number * 1000,
                    ))
                for number in range(6):
                    database.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, NULL, 10, 2, 0, 0)', (
                        f'ses_loop_{number}', 'Repeated review',
                        '/tmp/repo.harlan-agent-review-42-aaaaaaaaaaaa-deadbeef1234',
                        '{"id":"fixture"}', now - (number + 80) * 1000,
                        now - (number + 80) * 1000 + (60_000 if number == 5 else 0),
                    ))

            output = home / 'out'
            subprocess.run(
                [sys.executable, str(SCRIPT), str(output), '--days', '7', '--per-goal', '10'],
                env={**os.environ, 'HOME': str(home)}, capture_output=True, text=True, check=True,
            )
            self.assertTrue((output / 'adversarial_review' / 'ses_loop_5.md').exists())

    def test_baseline_session_joins_task_by_worktree_lease(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            opencode = home / '.local/share/opencode/opencode.db'
            journal = home / '.local/share/harlan-github-agent/state.sqlite'
            opencode.parent.mkdir(parents=True)
            journal.parent.mkdir(parents=True)

            task_id = 'a' * 64
            revision_id = 'b' * 64
            base_sha = 'c' * 40
            lease = hashlib.sha256(f'{task_id}:1'.encode()).hexdigest()[:12]
            session_id = 'ses_baseline_fixture'
            now = int(time.time() * 1000)

            with sqlite3.connect(opencode) as database:
                database.execute('''CREATE TABLE session (
                    id TEXT, title TEXT, directory TEXT, model TEXT,
                    time_created INTEGER, time_updated INTEGER, parent_id TEXT,
                    tokens_input INTEGER, tokens_output INTEGER,
                    tokens_reasoning INTEGER, tokens_cache_read INTEGER
                )''')
                database.execute('CREATE TABLE message (id TEXT, data TEXT)')
                database.execute('CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, data TEXT, time_created INTEGER)')
                database.execute('''INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, NULL, 10, 2, 0, 0)''', (
                    session_id,
                    'Repair baseline',
                    f'/tmp/repo.harlan-agent-baseline-{base_sha[:12]}-{lease}',
                    '{"id":"fixture"}',
                    now - 1000,
                    now,
                ))

            with sqlite3.connect(journal) as database:
                database.execute('''CREATE TABLE tasks (
                    id TEXT, kind TEXT, revision_id TEXT, updated_at TEXT,
                    state_tag TEXT, reason TEXT, attempts INTEGER,
                    recovery_attempts INTEGER, fence INTEGER
                )''')
                database.execute('CREATE TABLE task_transitions (task_id TEXT, to_tag TEXT, reason TEXT, created_at TEXT, fence INTEGER)')
                database.execute('''INSERT INTO tasks VALUES (?, 'baseline_repair', ?, ?, 'Completed', NULL, 1, 0, 1)''', (
                    task_id, revision_id, '2026-09-28T00:00:00Z',
                ))

            output = home / 'out'
            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(output), '--days', '7'],
                env={**os.environ, 'HOME': str(home)},
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertIn('baseline_repair: 1 sessions', result.stdout)
            transcript = (output / 'baseline_repair' / f'{session_id}.md').read_text()
            self.assertIn('"state": "Completed"', transcript)
            index = (output / 'baseline_repair' / 'INDEX.md').read_text()
            self.assertIn(f'"subject": "{base_sha[:12]}"', index)


if __name__ == '__main__':
    unittest.main()
