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
    def export_fixture(self, home, payload, extra_args=(), directory='/tmp/repo.harlan-agent-baseline-cccccccccccc-dddddddddddd', parts=None):
        database_path = home / '.local/share/opencode/opencode.db'
        database_path.parent.mkdir(parents=True)
        now = int(time.time() * 1000)
        with sqlite3.connect(database_path) as database:
            database.execute('''CREATE TABLE session (
                id TEXT, title TEXT, directory TEXT, model TEXT,
                time_created INTEGER, time_updated INTEGER, parent_id TEXT,
                tokens_input INTEGER, tokens_output INTEGER,
                tokens_reasoning INTEGER, tokens_cache_read INTEGER
            )''')
            database.execute('CREATE TABLE message (id TEXT, data TEXT)')
            database.execute('CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, data TEXT, time_created INTEGER)')
            database.execute('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, NULL, 10, 2, 0, 0)',
                             ('ses_fixture', payload, directory, '{"id":"fixture"}', now - 1000, now))
            database.execute('INSERT INTO message VALUES (?, ?)', ('message', '{"role":"assistant"}'))
            for number, part in enumerate(parts or [{'type': 'text', 'text': payload}]):
                database.execute('INSERT INTO part VALUES (?, ?, ?, ?, ?)',
                                 (f'part_{number:04}', 'ses_fixture', 'message', json.dumps(part), now + number))
        output = home / 'out'
        subprocess.run([sys.executable, str(SCRIPT), str(output), *extra_args],
                       env={**os.environ, 'HOME': str(home)}, capture_output=True, text=True, check=True)
        return output

    def test_redacts_quoted_sensitive_json_fields_in_transcript_and_index(self):
        with tempfile.TemporaryDirectory() as directory:
            secret = 'synthetic-signing-key-0123456789'
            payload = json.dumps({'password': secret, 'api_key': secret, 'cookieName': 'session'})
            output = self.export_fixture(Path(directory), payload)
            for path in output.rglob('*.md'):
                self.assertNotIn(secret, path.read_text())
            transcript = (output / 'baseline_repair/ses_fixture.md').read_text()
            self.assertIn('"cookieName": "session"', transcript)
            self.assertIn('"password": "***"', transcript)

    def test_redacts_known_bare_values_before_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            secret = 'synthetic-bare-key-0123456789'
            environment = home / 'fixture.env'
            environment.write_text(f'NUXT_SESSION_PASSWORD="{secret}"\nPUBLIC_LABEL=visible-label\n')
            output = self.export_fixture(home, f'{secret}\nvisible-label', ('--redact-env-file', str(environment)))
            for path in output.rglob('*.md'):
                self.assertNotIn(secret, path.read_text())
            self.assertIn('visible-label', (output / 'baseline_repair/ses_fixture.md').read_text())

    def test_redaction_source_errors_stop_before_writing_artifacts(self):
        for contents in (None, 'NUXT_SESSION_PASSWORD="unterminated\n'):
            with self.subTest(contents=contents), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                environment = home / 'fixture.env'
                if contents is not None:
                    environment.write_text(contents)
                with self.assertRaises(subprocess.CalledProcessError):
                    self.export_fixture(home, 'No export', ('--redact-env-file', str(environment)))
                self.assertFalse((home / 'out').exists())

    def test_redacts_escaped_values_without_changing_the_json_structure(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            secret = 'synthetic-quoted-"value"-with-trailing-backslash\\'
            environment = home / 'fixture.env'
            environment.write_text(f'PRIVATE_KEY={json.dumps(secret)}\n')
            parts = [{'type': 'tool', 'tool': 'custom', 'state': {
                'input': {'payload': secret, secret: 'visible-value', 'password': 'unlisted-sensitive-value'},
                'status': 'completed',
            }}]
            output = self.export_fixture(home, 'Escaped fixture', ('--redact-env-file', str(environment)), parts=parts)
            transcript = (output / 'baseline_repair/ses_fixture.md').read_text()
            self.assertNotIn('synthetic-quoted-', transcript)
            self.assertNotIn('unlisted-sensitive-value', transcript)
            self.assertIn('visible-value', transcript)

    def test_redacts_complete_parts_before_summary_and_tail_selection(self):
        secret = 'synthetic-boundary-secret-0123456789abcdefgh'
        multiline_secret = '\n'.join(f'synthetic-line-{number}' for number in range(10))
        for tool, boundary in (('custom', 300), ('skill', 200)):
            with self.subTest(tool=tool), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                environment = home / 'fixture.env'
                environment.write_text(f'NUXT_SESSION_PASSWORD={json.dumps(secret)}\nPRIVATE_KEY={json.dumps(multiline_secret)}\n')
                prefix = 'x' * (boundary - len('{"payload": "') - len(secret) + 2)
                parts = [
                    {'type': 'tool', 'tool': tool, 'state': {'input': {'payload': prefix + secret}, 'status': 'completed'}},
                    {'type': 'tool', 'tool': 'bash', 'state': {'input': {'command': 'echo safe'}, 'output': multiline_secret + '\nvisible-output', 'status': 'completed'}},
                    {'type': 'reasoning', 'text': multiline_secret + '\nvisible-reasoning'},
                ]
                output = self.export_fixture(home, 'Boundary fixture', ('--redact-env-file', str(environment)), parts=parts)
                transcript = (output / 'baseline_repair/ses_fixture.md').read_text()
                self.assertNotIn(secret[:20], transcript)
                self.assertNotIn('synthetic-line-', transcript)
                self.assertIn('visible-output', transcript)
                self.assertIn('visible-reasoning', transcript)

    def test_logged_finding_session_joins_its_task_lease_not_fingerprint_as_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            task_id = 'logged-finding:fixture-request'
            lease = hashlib.sha256(f'{task_id}:2'.encode()).hexdigest()[:12]
            journal = home / '.local/share/harlan-github-agent/state.sqlite'
            journal.parent.mkdir(parents=True)
            with sqlite3.connect(journal) as database:
                database.execute('''CREATE TABLE tasks (
                    id TEXT, kind TEXT, revision_id TEXT, updated_at TEXT,
                    state_tag TEXT, reason TEXT, attempts INTEGER,
                    recovery_attempts INTEGER, fence INTEGER
                )''')
                database.execute('CREATE TABLE task_transitions (task_id TEXT, to_tag TEXT, reason TEXT, created_at TEXT)')
                database.execute('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, NULL, 1, 0, 2)',
                                 (task_id, 'review_fix', 'bbbbbbbbbbbb-revision', '2026-10-06', 'Completed'))
                database.execute('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, NULL, 1, 0, 1)',
                                 ('unrelated-task', 'review_fix', 'aaaaaaaaaaaa-revision', '2026-10-07', 'Failed'))
            output = self.export_fixture(home, 'Repair done', directory=f'/tmp/repo.harlan-agent-fix-42-aaaaaaaaaaaa-{lease}')
            stats = json.loads((output / 'review_fix/INDEX.md').read_text().splitlines()[-1])
            self.assertEqual(stats['journal']['state'], 'Completed')
            self.assertEqual(stats['journal']['task'], task_id)

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
