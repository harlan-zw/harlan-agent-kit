import importlib.machinery
import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def load_indicator():
    path = Path(__file__).parents[1] / 'bin/harlan-github-agent-indicator'
    loader = importlib.machinery.SourceFileLoader('harlan_github_agent_indicator', str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


indicator = load_indicator()


def load_watch():
    path = Path(__file__).parents[1] / 'bin/harlan-github-agent-watch'
    loader = importlib.machinery.SourceFileLoader('harlan_github_agent_watch', str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


watch = load_watch()


class RunnerActivityTest(unittest.TestCase):
    def test_parses_named_runner_hosts_for_future_balancing(self):
        self.assertEqual(indicator.parse_runner_hosts(
            'Hogwild=ssh://hogwild,Desktop=unix:///var/run/docker.sock',
        ), [
            {'name': 'Hogwild', 'dockerHost': 'ssh://hogwild'},
            {'name': 'Desktop', 'dockerHost': 'unix:///var/run/docker.sock'},
        ])

    def test_keeps_runner_hosts_independent_when_one_is_unavailable(self):
        def run(command, **_options):
            docker_host = command[command.index('--host') + 1]
            if docker_host == 'unix:///var/run/docker.sock':
                raise RuntimeError('Desktop Docker is unavailable')
            if 'ps' in command:
                return subprocess.CompletedProcess(command, 0, stdout=(
                    '{"ID":"runner-1","State":"running","Status":"Up 10 minutes",'
                    '"Labels":"com.harlanzw.desktop-runner.repository=harlan-zw/example"}\n'
                ), stderr='')
            return subprocess.CompletedProcess(
                command,
                0,
                stdout='2026-08-26T09:47:07Z: Listening for Jobs\n',
                stderr='',
            )

        hosts = indicator.parse_runner_hosts(
            'Hogwild=ssh://hogwild,Desktop=unix:///var/run/docker.sock',
        )
        with patch.object(indicator.subprocess, 'run', side_effect=run):
            result = indicator.request_runner_hosts(hosts)

        self.assertEqual(result, [
            {
                '_tag': 'Available',
                'name': 'Hogwild',
                'runners': [{
                    'ID': 'runner-1',
                    'State': 'running',
                    'Status': 'Up 10 minutes',
                    'Labels': 'com.harlanzw.desktop-runner.repository=harlan-zw/example',
                    'Activity': {'_tag': 'Idle'},
                    'RunnerLabels': {'com.harlanzw.desktop-runner.repository': 'harlan-zw/example'},
                    'Host': 'Hogwild',
                }],
            },
            {
                '_tag': 'Unavailable',
                'name': 'Desktop',
                'message': 'Desktop Docker is unavailable',
            },
        ])

    def test_reports_idle_runner(self):
        self.assertEqual(indicator.runner_activity(
            {'State': 'running', 'Status': 'Up 10 minutes'},
            "2026-08-13T15:43:11Z: Listening for Jobs\n",
        ), {'_tag': 'Idle'})

    def test_reports_current_job(self):
        self.assertEqual(indicator.runner_activity(
            {'State': 'running', 'Status': 'Up 10 minutes'},
            "Listening for Jobs\n2026-08-13T15:50:00Z: Running job: deploy production\n",
        ), {'_tag': 'Running', 'job': 'deploy production'})

    def test_reports_offline_runner(self):
        self.assertEqual(indicator.runner_activity(
            {'State': 'exited', 'Status': 'Exited (1) 2 minutes ago'},
            '',
        ), {'_tag': 'Offline', 'detail': 'Exited (1) 2 minutes ago'})

    def test_summarises_runner_capacity_as_github_actions(self):
        runners = [
            {'Activity': {'_tag': 'Running'}},
            {'Activity': {'_tag': 'Idle'}},
        ]

        self.assertEqual(
            indicator.github_actions_status_label(runners, None),
            '🟢 2 self-hosted runners · 1 running · 1 idle',
        )

    def test_summarises_each_host_separately(self):
        host = {
            '_tag': 'Available',
            'name': 'Hogwild',
            'runners': [
                {'Activity': {'_tag': 'Running'}},
                {'Activity': {'_tag': 'Idle'}},
            ],
        }

        self.assertEqual(
            indicator.runner_host_status_label(host),
            '🟢 Hogwild · 2 self-hosted runners · 1 running · 1 idle',
        )

    def test_reports_runner_discovery_without_changing_agent_state(self):
        def unavailable():
            raise RuntimeError('Docker is unavailable')

        sources = indicator.read_system_sources(
            lambda: {'status': 'ready'},
            unavailable,
        )

        self.assertEqual(sources['harlanGithubAgent'], {
            '_tag': 'Available',
            'dashboard': {'status': 'ready'},
        })
        self.assertEqual(sources['githubActions'], {
            '_tag': 'Unavailable',
            'message': 'Docker is unavailable',
        })


class IndicatorDisplayTest(unittest.TestCase):
    def test_shows_remaining_weekly_codex_limit_and_reset(self):
        resets_at = 1787196635
        result = indicator.weekly_codex_limit({
            'rateLimitsByLimitId': {
                'codex': {
                    'primary': {'usedPercent': 10, 'windowDurationMins': 300, 'resetsAt': 1786700000},
                    'secondary': {'usedPercent': 89, 'windowDurationMins': 10080, 'resetsAt': resets_at},
                },
            },
        })

        self.assertEqual(result, {'_tag': 'Available', 'usedPercent': 89, 'resetsAt': resets_at})
        self.assertEqual(
            indicator.codex_limit_label(result, resets_at - 5 * 86400 - 18 * 3600),
            'Weekly Codex limit · 11% left · resets in 5d 18h',
        )

    def test_uses_minimal_coloured_state_markers(self):
        self.assertEqual(indicator.queue_state({'state': {'_tag': 'Active'}}), '🟢 Running')
        self.assertEqual(indicator.queue_state({'state': {'_tag': 'AwaitingApproval'}}), '🟠 Approval needed')
        self.assertEqual(indicator.queue_state({'state': {'_tag': 'ActionRequired'}}), '🔴 Action required')
        self.assertEqual(indicator.queue_state({'state': {'_tag': 'Queued'}}), '🔵 Queued')
        self.assertEqual(indicator.queue_state({'state': {'_tag': 'Pending'}}), '🟡 Pending')

    def test_marks_runner_activity_without_replacing_detail(self):
        runner = {
            'Names': 'runner-1',
            'RunnerLabels': {'com.harlanzw.desktop-runner.repository': 'harlan-zw/example'},
            'Activity': {'_tag': 'Running', 'job': 'deploy production'},
        }

        self.assertEqual(
            indicator.runner_label(runner),
            '🟢 Running · deploy production · harlan-zw/example · runner-1',
        )

    def test_keeps_progress_bar_for_active_agents(self):
        self.assertEqual(indicator.progress_bar(57), '▓▓▓░░')

    def test_reads_the_agent_profile_the_dashboard_sends(self):
        dashboard = {
            'agentProfile': {
                'provider': 'opencode',
                'roles': {'adversarial_review': {'model': 'opencode-go/deepseek-v4-flash', 'reasoningEffort': 'high'}},
            },
        }

        self.assertEqual(indicator.active_provider(dashboard), 'opencode')
        self.assertEqual(
            indicator.agent_provider_label(dashboard),
            'Agent provider · opencode · opencode-go/deepseek-v4-flash · high',
        )

    def test_labels_active_agents_with_their_role(self):
        agent = {
            'role': 'issue_triage',
            'progress': {'percent': 57, 'label': 'Checking issue context'},
            'repository': 'harlan-zw/example',
            'itemNumber': 12,
        }

        self.assertEqual(
            indicator.active_agent_label(agent),
            '▓▓▓░░  57% · Issue triage · harlan-zw/example #12',
        )

    def test_uses_canonical_labels_for_every_agent_role(self):
        labels = {
            'adversarial_review': 'Adversarial review',
            'baseline_repair': 'Baseline repair',
            'conflict_resolution': 'Conflict resolution',
            'issue_triage': 'Issue triage',
            'issue_work': 'Issue work',
            'review_fix': 'Repair',
        }

        for role, label in labels.items():
            with self.subTest(role=role):
                self.assertEqual(indicator.agent_role_label({'role': role}), label)

    def test_exposes_pause_and_resume_for_agent_control_state(self):
        self.assertEqual(indicator.agent_control_action({'_tag': 'Running'}), ('⏸ Pause agents', 'pause'))
        self.assertEqual(
            indicator.agent_control_action({'_tag': 'Paused', 'pausedAt': '2026-08-14T00:00:00.000Z'}),
            ('▶ Resume agents', 'resume'),
        )

    def test_selection_mode_label(self):
        self.assertIsNone(indicator.selection_mode_label({'selectionMode': 'auto'}))
        self.assertIn('Manual selection', indicator.selection_mode_label({'selectionMode': 'manual'}))

    def test_summarises_loading_running_paused_and_unavailable_states(self):
        self.assertEqual(indicator.indicator_summary(None, [], None), ('🟡', 'Loading Harlan GitHub Agent'))
        self.assertEqual(
            indicator.indicator_summary({'agentControl': {'_tag': 'Running'}, 'queue': []}, [{}], None),
            ('🟢 1', '1 agent running · Queue empty'),
        )
        self.assertEqual(
            indicator.indicator_summary({'agentControl': {'_tag': 'Paused'}, 'queue': [{}, {}]}, [], None),
            ('🟡', 'Agents paused · 2 in Queue'),
        )
        self.assertEqual(indicator.indicator_summary(None, [], 'Connection refused'), ('🔴', 'Harlan GitHub Agent unavailable'))

    def test_keeps_runner_counts_out_of_the_agent_summary(self):
        _, title = indicator.indicator_summary(
            {'agentControl': {'_tag': 'Running'}, 'queue': [{}]},
            [],
            None,
        )

        self.assertEqual(title, '0 agents running · 1 in Queue')
        self.assertNotIn('runner', title)

    def test_raises_action_required_for_an_exhausted_incident(self):
        dashboard = {
            'status': 'ready',
            'agentControl': {'_tag': 'Running'},
            'queue': [],
            'incidents': [{
                'recovery': {'_tag': 'Exhausted'},
                'severity': 'error',
            }],
        }

        self.assertEqual(
            indicator.indicator_summary(dashboard, [], None),
            ('🔴', 'Harlan GitHub Agent · Action required'),
        )
        self.assertEqual(
            indicator.harlan_github_agent_status_label(dashboard, [], None),
            '🔴 Action required · Queue empty',
        )

    def test_opens_a_read_only_watch_terminal_for_the_exact_session(self):
        agent = {
            'id': 'task-123',
            'repository': 'harlan-zw/example',
            'itemNumber': 24,
            'session': {'_tag': 'Connected', 'id': '019fff56-466c-7980-9a63-962018752af2'},
        }

        with patch.object(indicator.subprocess, 'Popen') as spawn:
            indicator.open_agent_watch(agent)

        spawn.assert_called_once_with([
            '/usr/bin/ghostty',
            '--title=Watch logs · harlan-zw/example #24',
            '-e',
            sys.executable,
            str(indicator.WATCHER),
            '019fff56-466c-7980-9a63-962018752af2',
        ], start_new_session=True)


class AgentControlRequestTest(unittest.TestCase):
    def test_sends_authenticated_pause_request(self):
        requests = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'{"_tag":"Paused","pausedAt":"2026-08-14T00:00:00.000Z"}'

        def open_request(request, timeout):
            requests.append((request, timeout))
            return Response()

        with tempfile.TemporaryDirectory() as directory:
            password_file = Path(directory) / 'dashboard-password'
            password_file.write_text('secret\n')
            with patch.object(indicator, 'PASSWORD_FILE', password_file), patch.object(
                indicator.urllib.request,
                'urlopen',
                side_effect=open_request,
            ):
                result = indicator.request_agent_control('pause')

        request, timeout = requests[0]
        self.assertEqual(result, {'_tag': 'Paused', 'pausedAt': '2026-08-14T00:00:00.000Z'})
        self.assertEqual(request.full_url, 'http://harlan-github-agent.local/api/agents/pause')
        self.assertEqual(request.get_method(), 'POST')
        self.assertEqual(request.get_header('Origin'), 'http://harlan-github-agent.local')
        self.assertEqual(request.get_header('Authorization'), 'Basic YWdlbnQ6c2VjcmV0')
        self.assertEqual(timeout, 3)

    def test_sends_authenticated_eject_request_for_the_exact_agent(self):
        requests = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'{"_tag":"Ejected"}'

        def open_request(request, timeout):
            requests.append((request, timeout))
            return Response()

        with tempfile.TemporaryDirectory() as directory:
            password_file = Path(directory) / 'dashboard-password'
            password_file.write_text('secret\n')
            with patch.object(indicator, 'PASSWORD_FILE', password_file), patch.object(
                indicator.urllib.request,
                'urlopen',
                side_effect=open_request,
            ):
                result = indicator.request_agent_eject('task-123')

        request, timeout = requests[0]
        self.assertEqual(result, {'_tag': 'Ejected'})
        self.assertEqual(request.full_url, 'http://harlan-github-agent.local/api/agents/eject')
        self.assertEqual(request.get_method(), 'POST')
        self.assertEqual(request.data, b'{"taskId":"task-123"}')
        self.assertEqual(request.get_header('Content-type'), 'application/json')
        self.assertEqual(request.get_header('Origin'), 'http://harlan-github-agent.local')
        self.assertEqual(request.get_header('Authorization'), 'Basic YWdlbnQ6c2VjcmV0')
        self.assertEqual(timeout, 10)


class AgentSelectionTest(unittest.TestCase):
    def test_reads_the_selection_the_dashboard_sends(self):
        dashboard = {'agentSelection': {'_tag': 'Pinned', 'provider': 'opencode', 'model': None, 'reasoningEffort': 'high'}}

        self.assertEqual(
            indicator.agent_selection(dashboard),
            {'_tag': 'Pinned', 'provider': 'opencode', 'model': None, 'reasoningEffort': 'high'},
        )

    def test_reads_a_selection_that_follows_the_configuration(self):
        dashboard = {'agentSelection': {'_tag': 'FollowsConfiguration'}}

        self.assertEqual(indicator.agent_selection(dashboard), {'_tag': 'FollowsConfiguration'})

    def test_reports_no_selection_when_the_dashboard_is_unavailable(self):
        self.assertIsNone(indicator.agent_selection(None))
        self.assertIsNone(indicator.agent_selection({}))

    def test_marks_the_current_provider_model_and_reasoning_effort(self):
        choices = indicator.agent_selection_choices({
            '_tag': 'Pinned',
            'provider': 'opencode',
            'model': 'opencode-go/deepseek-v4-pro',
            'reasoningEffort': None,
        }, 'opencode')
        selected = [entry['label'] for entry in choices if entry['_tag'] == 'Choice' and entry['selected']]

        self.assertEqual(selected, ['opencode', 'opencode-go/deepseek-v4-pro', 'Provider default'])

    def test_marks_following_the_configuration(self):
        choices = indicator.agent_selection_choices({'_tag': 'FollowsConfiguration'}, 'codex')
        selected = [entry['label'] for entry in choices if entry['_tag'] == 'Choice' and entry['selected']]

        self.assertEqual(selected, ['Follow configuration', 'Provider default', 'Provider default'])

    def test_offers_a_way_back_to_the_configuration(self):
        choices = indicator.agent_selection_choices({
            '_tag': 'Pinned',
            'provider': 'opencode',
            'model': 'opencode-go/deepseek-v4-pro',
            'reasoningEffort': 'high',
        }, 'opencode')
        follow = next(
            entry for entry in choices
            if entry['_tag'] == 'Choice' and entry['label'] == 'Follow configuration'
        )

        self.assertEqual(follow['selection'], {'_tag': 'FollowsConfiguration'})
        self.assertFalse(follow['selected'])

    def test_lists_the_configured_provider_models_while_following_the_configuration(self):
        choices = indicator.agent_selection_choices({'_tag': 'FollowsConfiguration'}, 'opencode')
        models = [
            entry['selection']['model']
            for entry in choices
            if entry['_tag'] == 'Choice' and entry['selection'].get('_tag') == 'Pinned' and 'model' in entry['selection']
        ]

        self.assertIn('opencode-go/deepseek-v4-pro', models)
        self.assertNotIn('gpt-5.6-luna', models)

    def test_offers_only_the_models_of_the_selected_provider(self):
        choices = indicator.agent_selection_choices({
            '_tag': 'Pinned',
            'provider': 'codex',
            'model': None,
            'reasoningEffort': None,
        }, 'codex')
        models = [
            entry['selection']['model']
            for entry in choices
            if entry['_tag'] == 'Choice'
            and 'model' in entry['selection']
            and entry['selection'].get('provider') == 'codex'
        ]

        self.assertIn('gpt-5.6-luna', models)
        self.assertNotIn('opencode-go/deepseek-v4-pro', models)

    def test_switching_provider_clears_the_model_and_reasoning_effort(self):
        choices = indicator.agent_selection_choices({
            '_tag': 'Pinned',
            'provider': 'codex',
            'model': 'gpt-5.6-luna',
            'reasoningEffort': 'max',
        }, 'codex')
        opencode = next(
            entry for entry in choices
            if entry['_tag'] == 'Choice' and entry['label'] == 'opencode'
        )

        self.assertEqual(
            opencode['selection'],
            {'_tag': 'Pinned', 'provider': 'opencode', 'model': None, 'reasoningEffort': None},
        )

    def test_lists_nothing_without_a_selection(self):
        self.assertEqual(indicator.agent_selection_choices(None, None), [])
        self.assertEqual(indicator.agent_selection_choices({'_tag': 'FollowsConfiguration'}, None), [])

    def test_sends_authenticated_agent_switch_request(self):
        requests = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'{"provider":"opencode","model":null,"reasoningEffort":null}'

        def open_request(request, timeout):
            requests.append((request, timeout))
            return Response()

        with tempfile.TemporaryDirectory() as directory:
            password_file = Path(directory) / 'dashboard-password'
            password_file.write_text('secret\n')
            with patch.object(indicator, 'PASSWORD_FILE', password_file), patch.object(
                indicator.urllib.request,
                'urlopen',
                side_effect=open_request,
            ):
                result = indicator.request_agent_select({'provider': 'opencode', 'model': None, 'reasoningEffort': None})

        request, timeout = requests[0]
        self.assertEqual(result, {'provider': 'opencode', 'model': None, 'reasoningEffort': None})
        self.assertEqual(request.full_url, 'http://harlan-github-agent.local/api/agents/select')
        self.assertEqual(request.get_method(), 'POST')
        self.assertEqual(request.data, b'{"provider":"opencode","model":null,"reasoningEffort":null}')
        self.assertEqual(request.get_header('Content-type'), 'application/json')
        self.assertEqual(request.get_header('Origin'), 'http://harlan-github-agent.local')
        self.assertEqual(request.get_header('Authorization'), 'Basic YWdlbnQ6c2VjcmV0')
        self.assertEqual(timeout, 3)


class WatchLogTest(unittest.TestCase):
    def test_formats_agent_commands_results_and_completion(self):
        timestamp = '2026-08-14T08:10:23.321Z'
        self.assertEqual(watch.format_event({
            'timestamp': timestamp,
            'type': 'event_msg',
            'payload': {'type': 'agent_message', 'message': 'Checking the failing test.'},
        }), '08:10:23  Agent\nChecking the failing test.')
        self.assertEqual(watch.format_event({
            'timestamp': timestamp,
            'type': 'response_item',
            'payload': {
                'type': 'custom_tool_call',
                'name': 'exec',
                'input': 'const r = await tools.exec_command({cmd:"pnpm test",yield_time_ms:30000});text(r.output)',
            },
        }), '08:10:23  $ pnpm test')
        self.assertEqual(watch.format_event({
            'timestamp': timestamp,
            'type': 'response_item',
            'payload': {'type': 'custom_tool_call_output', 'output': [
                {'type': 'input_text', 'text': 'Script completed\nOutput:\n'},
                {'type': 'input_text', 'text': 'passed\n'},
            ]},
        }), '08:10:23  Result\nScript completed\nOutput:\npassed')
        self.assertEqual(watch.format_event({
            'timestamp': timestamp,
            'type': 'event_msg',
            'payload': {'type': 'task_complete'},
        }), '08:10:23  Task complete')

    def test_finds_the_exact_newest_session_log(self):
        session_id = '019fff56-466c-7980-9a63-962018752af2'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            older = root / f'rollout-old-{session_id}.jsonl'
            newer = root / 'nested' / f'rollout-new-{session_id}.jsonl'
            older.write_text('{}\n')
            newer.parent.mkdir()
            newer.write_text('{}\n')
            os.utime(older, (1, 1))
            os.utime(newer, (2, 2))
            self.assertEqual(watch.find_session_log(session_id, root), newer)

        with self.assertRaisesRegex(ValueError, 'Invalid Codex session ID'):
            watch.find_session_log('../session', Path('/tmp'))

    def test_renders_commands_with_terminal_syntax_highlighting(self):
        output = io.StringIO()
        event = {
            'timestamp': '2026-08-14T08:10:23.321Z',
            'type': 'response_item',
            'payload': {
                'type': 'custom_tool_call',
                'name': 'exec',
                'input': 'const r = await tools.exec_command({cmd:"pnpm test"});text(r.output)',
            },
        }

        self.assertTrue(watch.render_event(event, watch.Console(
            file=output,
            force_terminal=True,
            color_system='truecolor',
            width=100,
        )))
        self.assertIn('pnpm test', output.getvalue())
        self.assertIn('\x1b[', output.getvalue())


if __name__ == '__main__':
    unittest.main()
