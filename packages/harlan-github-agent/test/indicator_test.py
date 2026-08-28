import importlib.machinery
import importlib.util
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from datetime import datetime, timezone
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


def load_runner_indicator():
    path = Path(__file__).parents[1] / 'bin/harlan-github-runner-indicator'
    loader = importlib.machinery.SourceFileLoader('harlan_github_runner_indicator', str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


runner_indicator = load_runner_indicator()


def load_watch():
    path = Path(__file__).parents[1] / 'bin/harlan-github-agent-watch'
    loader = importlib.machinery.SourceFileLoader('harlan_github_agent_watch', str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


watch = load_watch()


class StubIndicator:
    def __init__(self):
        self.menus = []

    def set_menu(self, menu):
        self.menus.append(menu)


def menu_labels(menu):
    return [child.get_label() for child in menu.get_children()]


def selection_dashboard(selection, provider):
    return {
        'agentSelection': selection,
        'agentProfile': {'provider': provider},
        'agentProviderOrder': ['opencode', 'codex'],
        'agentModels': {
            'codex': ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
            'opencode': ['zai-coding-plan/glm-5.3-flash'],
        },
        'reasoningEfforts': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    }


class RunnerActivityTest(unittest.TestCase):
    def test_parses_named_runner_hosts_for_future_balancing(self):
        self.assertEqual(runner_indicator.parse_runner_hosts(
            'Hogwild=ssh://hogwild|system:hogwild-github-runner.service,'
            'Desktop=unix:///var/run/docker.sock|user:harlan-desktop-github-runner.service',
        ), [
            {
                'name': 'Hogwild',
                'dockerHost': 'ssh://hogwild',
                'control': {'scope': 'system', 'unit': 'hogwild-github-runner.service'},
            },
            {
                'name': 'Desktop',
                'dockerHost': 'unix:///var/run/docker.sock',
                'control': {'scope': 'user', 'unit': 'harlan-desktop-github-runner.service'},
            },
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

        hosts = runner_indicator.parse_runner_hosts(
            'Hogwild=ssh://hogwild,Desktop=unix:///var/run/docker.sock',
        )
        with patch.object(runner_indicator.subprocess, 'run', side_effect=run):
            result = runner_indicator.request_runner_hosts(hosts)

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

    def test_ignores_a_runner_that_disappears_between_list_and_logs(self):
        def run(command, **_options):
            if 'ps' in command:
                return subprocess.CompletedProcess(command, 0, stdout=(
                    '{"ID":"gone","State":"running","Status":"Up 2 seconds",'
                    '"Labels":"com.harlanzw.desktop-runner.repository=harlan-zw/example"}\n'
                ), stderr='')
            return subprocess.CompletedProcess(
                command,
                1,
                stdout='',
                stderr='Error response from daemon: No such container: gone',
            )

        host = runner_indicator.parse_runner_hosts('Hogwild=ssh://hogwild')[0]

        self.assertEqual(runner_indicator.request_runners(host, run), [])

    def test_keeps_last_known_runner_state_during_a_short_host_failure(self):
        previous = {'_tag': 'Available', 'hosts': [{
            '_tag': 'Available',
            'name': 'Hogwild',
            'observedAt': 100.0,
            'runners': [{'Activity': {'_tag': 'Idle'}}],
        }]}
        current = {'_tag': 'Available', 'hosts': [{
            '_tag': 'Unavailable',
            'name': 'Hogwild',
            'message': 'SSH connection reset',
        }]}

        merged = runner_indicator.merge_runner_source(previous, current, 118.9)

        self.assertEqual(merged['hosts'][0]['runners'], [{'Activity': {'_tag': 'Idle'}}])
        self.assertEqual(merged['hosts'][0]['stale'], {
            'message': 'SSH connection reset',
            'observedAt': 100.0,
        })
        self.assertEqual(
            runner_indicator.runner_host_status_label(merged['hosts'][0], 118.9),
            '🟠 Hogwild · last known status 18s old · 1 self-hosted runner · 1 idle',
        )

    def test_reports_idle_runner(self):
        self.assertEqual(runner_indicator.runner_activity(
            {'State': 'running', 'Status': 'Up 10 minutes'},
            "2026-08-13T15:43:11Z: Listening for Jobs\n",
        ), {'_tag': 'Idle'})

    def test_reports_current_job(self):
        self.assertEqual(runner_indicator.runner_activity(
            {'State': 'running', 'Status': 'Up 10 minutes'},
            "Listening for Jobs\n2026-08-13T15:50:00Z: Running job: deploy production\n",
        ), {'_tag': 'Running', 'job': 'deploy production'})

    def test_reports_offline_runner(self):
        self.assertEqual(runner_indicator.runner_activity(
            {'State': 'exited', 'Status': 'Exited (1) 2 minutes ago'},
            '',
        ), {'_tag': 'Offline', 'detail': 'Exited (1) 2 minutes ago'})

    def test_summarises_runner_capacity_as_github_actions(self):
        runners = [
            {'Activity': {'_tag': 'Running'}},
            {'Activity': {'_tag': 'Idle'}},
        ]

        self.assertEqual(
            runner_indicator.github_actions_status_label(runners, None),
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
            runner_indicator.runner_host_status_label(host),
            '🟢 Hogwild · 2 self-hosted runners · 1 running · 1 idle',
        )

    def test_appends_the_failure_message_to_an_unavailable_runner_host(self):
        self.assertEqual(
            runner_indicator.runner_host_status_label({
                '_tag': 'Unavailable',
                'name': 'Hogwild',
                'message': 'ssh://hogwild refused',
            }),
            '🔴 Hogwild · unavailable · ssh://hogwild refused',
        )

    def test_reports_runner_discovery_failure(self):
        def unavailable():
            raise RuntimeError('Docker is unavailable')

        source = runner_indicator.read_runner_source(unavailable)

        self.assertEqual(source, {
            '_tag': 'Unavailable',
            'message': 'Docker is unavailable',
        })

    def test_lists_only_active_self_hosted_jobs(self):
        runs = [
            {'id': 12, 'name': 'Code', 'status': 'in_progress', 'html_url': 'https://github.com/run/12'},
            {'id': 13, 'name': 'Docs', 'status': 'completed', 'html_url': 'https://github.com/run/13'},
        ]

        result = runner_indicator.collect_workflow_jobs(
            'harlan-zw/example',
            runs,
            lambda _run_id: [
                {
                    'name': 'test',
                    'status': 'queued',
                    'labels': ['self-hosted', 'harlan-desktop-ci'],
                    'html_url': 'https://github.com/job/1',
                },
                {
                    'name': 'cloud',
                    'status': 'in_progress',
                    'labels': ['ubuntu-latest'],
                    'html_url': 'https://github.com/job/2',
                },
            ],
        )

        self.assertEqual(result, [{
            '_tag': 'Queued',
            'repository': 'harlan-zw/example',
            'workflow': 'Code',
            'name': 'test',
            'url': 'https://github.com/job/1',
        }])

    def test_keeps_jobs_when_one_repository_fails(self):
        errors = []

        def fake_github_api(path):
            if path.startswith('repos/broken/repo'):
                raise RuntimeError('renamed repository')
            if '/jobs' in path:
                return {'jobs': [{
                    'name': 'test',
                    'status': 'queued',
                    'labels': ['self-hosted'],
                    'html_url': 'https://github.com/job/9',
                }]}
            if 'status=queued' in path:
                return {'workflow_runs': [
                    {'id': 7, 'name': 'Code', 'status': 'in_progress', 'html_url': 'https://github.com/run/7'},
                ]}
            return {'workflow_runs': []}

        with patch.object(runner_indicator, 'github_api', side_effect=fake_github_api):
            jobs = runner_indicator.request_workflow_jobs(['good/repo', 'broken/repo'], errors.append)

        self.assertEqual(jobs, [{
            '_tag': 'Queued',
            'repository': 'good/repo',
            'workflow': 'Code',
            'name': 'test',
            'url': 'https://github.com/job/9',
        }])
        self.assertEqual(errors, ['broken/repo · Jobs unavailable · renamed repository'])

    def test_follows_pagination_for_queued_jobs_beyond_the_first_page(self):
        def fake_github_api(path):
            if path == 'repos/harlan-zw/example/actions/runs?status=queued&page=1&per_page=50':
                return {'workflow_runs': [
                    {'id': index, 'name': 'Recent', 'status': 'in_progress', 'html_url': f'https://github.com/run/{index}'}
                    for index in range(50)
                ]}
            if path == 'repos/harlan-zw/example/actions/runs?status=queued&page=2&per_page=50':
                return {'workflow_runs': [
                    {'id': 99, 'name': 'Old', 'status': 'queued', 'html_url': 'https://github.com/run/99'},
                ]}
            if '/runs/99/jobs' in path:
                return {'jobs': [{
                    'name': 'test',
                    'status': 'queued',
                    'labels': ['self-hosted'],
                    'html_url': 'https://github.com/job/99',
                }]}
            return {'jobs': []}

        with patch.object(runner_indicator, 'github_api', side_effect=fake_github_api):
            jobs = runner_indicator.request_workflow_jobs(['harlan-zw/example'])

        self.assertEqual(jobs, [{
            '_tag': 'Queued',
            'repository': 'harlan-zw/example',
            'workflow': 'Old',
            'name': 'test',
            'url': 'https://github.com/job/99',
        }])

    def test_follows_pagination_for_jobs_within_one_run(self):
        requests = []

        def job(index):
            return {
                'name': f'test {index}',
                'status': 'in_progress',
                'labels': ['self-hosted'],
                'html_url': f'https://github.com/job/{index}',
            }

        def fake_github_api(path):
            requests.append(path)
            if path == 'repos/harlan-zw/example/actions/runs?status=queued&page=1&per_page=50':
                return {'workflow_runs': [
                    {'id': 7, 'name': 'Code', 'status': 'in_progress', 'html_url': 'https://github.com/run/7'},
                ]}
            if path == 'repos/harlan-zw/example/actions/runs?status=in_progress&page=1&per_page=50':
                return {'workflow_runs': []}
            if path == 'repos/harlan-zw/example/actions/runs/7/jobs?page=1&per_page=100':
                return {'jobs': [job(index) for index in range(100)]}
            if path == 'repos/harlan-zw/example/actions/runs/7/jobs?page=2&per_page=100':
                return {'jobs': [job(index) for index in range(100, 135)]}
            raise AssertionError(f'unexpected GitHub API request {path}')

        with patch.object(runner_indicator, 'github_api', side_effect=fake_github_api):
            jobs = runner_indicator.request_workflow_jobs(['harlan-zw/example'])

        self.assertEqual(len(jobs), 135)
        self.assertEqual(
            [path for path in requests if '/jobs' in path],
            [
                'repos/harlan-zw/example/actions/runs/7/jobs?page=1&per_page=100',
                'repos/harlan-zw/example/actions/runs/7/jobs?page=2&per_page=100',
            ],
        )

    def test_stops_a_remote_runner_service_without_waiting_for_jobs(self):
        commands = []
        host = runner_indicator.parse_runner_hosts(
            'Hogwild=ssh://hogwild|system:hogwild-github-runner.service',
        )[0]

        runner_indicator.set_host_accepting_jobs(
            host,
            False,
            lambda command, **_options: commands.append(command),
        )

        self.assertEqual(commands, [[
            'ssh',
            'hogwild',
            'sudo',
            '-n',
            'systemctl',
            'stop',
            '--no-block',
            'hogwild-github-runner.service',
        ]])


class IndicatorDisplayTest(unittest.TestCase):
    def test_shows_every_provider_limit_from_the_dashboard(self):
        now = datetime(2026, 8, 28, tzinfo=timezone.utc).timestamp()
        dashboard = {'providerCapacities': [
            {
                'provider': 'codex',
                'reservePercent': 20,
                'capacity': {'_tag': 'Available', 'usedPercent': 86, 'resetsAt': '2026-08-29T00:00:00.000Z'},
            },
            {
                'provider': 'opencode',
                'reservePercent': 50,
                'capacity': {'_tag': 'Available', 'usedPercent': 12, 'resetsAt': '2026-08-28T02:00:00.000Z'},
            },
        ]}

        self.assertEqual(indicator.provider_capacity_labels(dashboard, now), [
            'Weekly Codex limit · 14% left · 20% Reserve reached · resets in 1d 0h',
            'opencode · 88% left · 50% Reserve · resets in 2h 0m',
        ])

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
            runner_indicator.runner_label(runner),
            '🟢 Running · deploy production · harlan-zw/example · runner-1',
        )

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
            '🟢 Issue triage · 57% · harlan-zw/example #12',
        )

    def test_reads_live_activity_without_inventing_completion(self):
        agent = {
            'activity': [{
                '_tag': 'Command',
                'at': '2026-08-14T00:00:00.000Z',
                'command': 'pnpm test',
                'output': '',
                'exitCode': None,
            }],
            'progress': {'percent': 70, 'label': 'Running tests and checks'},
        }

        self.assertEqual(indicator.active_agent_activity_label(agent), 'Running pnpm test')

    def test_agent_submenu_shows_phase_and_live_activity(self):
        agent = {
            '_tag': 'ActiveAgent',
            'role': 'issue_triage',
            'repository': 'harlan-zw/example',
            'itemNumber': 12,
            'subjectKind': 'issue',
            'subjectUrl': 'https://github.com/harlan-zw/example/issues/12',
            'session': {'_tag': 'Connected', 'id': 'session-1'},
            'progress': {'percent': 70, 'label': 'Running tests and checks'},
            'activity': [{
                '_tag': 'Command',
                'at': '2026-08-14T00:00:00.000Z',
                'command': 'pnpm test',
                'output': '',
                'exitCode': None,
            }],
        }
        sources = {'harlanGithubAgent': {'_tag': 'Available', 'dashboard': {
            'status': 'ready',
            'agentControl': {'_tag': 'Running'},
            'agents': [agent],
            'queue': [],
            'incidents': [],
        }}}
        stub = StubIndicator()

        indicator.build_menu(
            stub,
            sources,
            None,
            lambda: None,
            lambda *_args: None,
            lambda *_args: None,
            lambda *_args: None,
        )

        active = next(
            item for item in stub.menus[0].get_children()
            if item.get_label().startswith('🟢 Issue triage') and item.get_submenu() is not None
        )
        labels = menu_labels(active.get_submenu())
        self.assertEqual(labels[:2], ['70% · Running tests and checks', 'Running pnpm test'])

    def test_system_pane_shows_a_running_routine_and_its_live_activity(self):
        run = {
            'id': 'routine-run-1',
            'repository': 'harlan-zw/example',
            'name': 'sentry-checkin',
            'state': {'_tag': 'Running'},
            'progress': {'percent': 55, 'label': 'Checking the repository'},
            'activity': [{
                '_tag': 'Reasoning',
                'at': '2026-08-14T00:00:00.000Z',
                'text': 'Reading Sentry issues.',
            }],
        }
        sources = {
            'harlanGithubAgent': {'_tag': 'Available', 'dashboard': {
                'status': 'ready',
                'agentControl': {'_tag': 'Running'},
                'agents': [],
                'routineRuns': [run],
                'queue': [],
                'incidents': [],
            }},
        }
        stub = StubIndicator()

        indicator.build_menu(
            stub,
            sources,
            None,
            lambda: None,
            lambda *_args: None,
            lambda *_args: None,
            lambda *_args: None,
        )

        routine = next(
            item for item in stub.menus[0].get_children()
            if item.get_label().startswith('🟢 Routine')
        )
        self.assertEqual(
            menu_labels(routine.get_submenu()),
            ['55% · Checking the repository', 'Reading Sentry issues.', 'Open repository'],
        )
        self.assertIn('🟢 1 agent running · Queue empty', menu_labels(stub.menus[0]))

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

    def test_reports_a_reached_reserve_as_normal_system_state(self):
        dashboard = {
            'status': 'ready',
            'agentStart': {'_tag': 'ReserveReached'},
            'agentControl': {'_tag': 'Running'},
            'queue': [{}, {}],
            'incidents': [],
        }

        self.assertEqual(indicator.dashboard_attention(dashboard), {'_tag': 'ReserveReached'})
        self.assertEqual(indicator.indicator_summary(dashboard, [], None), ('🟡', 'Reserve reached · 2 in Queue'))

    def test_treats_an_all_unavailable_host_list_as_an_error_state(self):
        source = runner_indicator.read_runner_source(
            lambda: [{'_tag': 'Unavailable', 'name': 'Hogwild', 'message': 'ssh://hogwild refused'}],
        )
        stub = StubIndicator()

        runner_indicator.build_menu(
            stub,
            source,
            {'_tag': 'Available', 'jobs': []},
            None,
            lambda: None,
            lambda *_args: None,
        )
        labels = menu_labels(stub.menus[0])

        self.assertIn('🔴 Status unavailable', labels)
        self.assertNotIn('⚪ No self-hosted runners found', labels)
        self.assertIn('🔴 Hogwild · unavailable · ssh://hogwild refused', labels)

    def test_shows_queued_jobs_and_runner_server_control(self):
        source = {'_tag': 'Available', 'hosts': [{
            '_tag': 'Available',
            'name': 'Hogwild',
            'runners': [],
            'control': {
                'configuration': {'scope': 'system', 'unit': 'hogwild-github-runner.service'},
                'status': 'active',
            },
        }]}
        jobs = {'_tag': 'Available', 'jobs': [{
            '_tag': 'Queued',
            'repository': 'harlan-zw/example',
            'workflow': 'Code',
            'name': 'test',
            'url': 'https://github.com/job/1',
        }]}
        stub = StubIndicator()

        runner_indicator.build_menu(
            stub,
            source,
            jobs,
            None,
            lambda: None,
            lambda *_args: None,
        )

        menu = stub.menus[0]
        self.assertIn('Queued jobs · 1', menu_labels(menu))
        host = next(item for item in menu.get_children() if item.get_label().startswith('⚪ Hogwild'))
        self.assertIn('Stop accepting new jobs…', menu_labels(host.get_submenu()))

    def test_agent_menu_does_not_include_github_actions(self):
        sources = indicator.read_system_sources(lambda: {'status': 'ready'})
        stub = StubIndicator()

        indicator.build_menu(
            stub,
            sources,
            None,
            lambda: None,
            lambda *_args: None,
            lambda *_args: None,
            lambda *_args: None,
        )

        self.assertNotIn('GitHub Actions', menu_labels(stub.menus[0]))

    def test_opens_a_read_only_watch_terminal_for_the_exact_session(self):
        agent = {
            'id': 'task-123',
            'provider': 'opencode',
            'repository': 'harlan-zw/example',
            'itemNumber': 24,
            'session': {'_tag': 'Connected', 'id': 'ses_fc1f02fd3ffeCm7SwBkWsH6YGb'},
        }

        with patch.object(indicator.subprocess, 'Popen') as spawn:
            indicator.open_agent_watch(agent)

        spawn.assert_called_once_with([
            '/usr/bin/ghostty',
            '--title=Watch logs · harlan-zw/example #24',
            '-e',
            'ssh',
            '-t',
            'hogwild',
            '/usr/bin/python3 /home/harlan/.local/share/harlan-github-agent/service/packages/harlan-github-agent/bin/harlan-github-agent-watch opencode ses_fc1f02fd3ffeCm7SwBkWsH6YGb',
        ], start_new_session=True)

    def test_does_not_open_a_watch_terminal_for_an_invalid_session(self):
        agent = {
            'id': 'task-123',
            'provider': 'opencode',
            'repository': 'harlan-zw/example',
            'itemNumber': 24,
            'session': {'_tag': 'Connected', 'id': 'ses_abc12345;touch_/tmp/pwned'},
        }

        with patch.object(indicator.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(ValueError, 'Invalid opencode session ID'):
                indicator.open_agent_watch(agent)

        spawn.assert_not_called()

    def test_opens_the_ejected_session_on_hogwild(self):
        ejected = {
            '_tag': 'Ejected',
            'provider': 'opencode',
            'sessionId': 'ses_fc1f02fd3ffeCm7SwBkWsH6YGb',
            'repository': 'harlan-zw/example',
            'itemNumber': 24,
        }

        with patch.object(indicator.subprocess, 'Popen') as spawn:
            indicator.open_ejected_session(ejected)

        spawn.assert_called_once_with([
            '/usr/bin/ghostty',
            '--title=opencode · harlan-zw/example #24',
            '-e',
            'ssh',
            '-t',
            'hogwild',
            '/home/harlan/.local/bin/opencode --session ses_fc1f02fd3ffeCm7SwBkWsH6YGb',
        ], start_new_session=True)

    def test_opens_a_valid_codex_session_on_hogwild(self):
        ejected = {
            '_tag': 'Ejected',
            'provider': 'codex',
            'sessionId': '0f0e0d0c-0b0a-4968-8956-2631d0c871f9',
            'repository': 'harlan-zw/example',
            'itemNumber': 24,
        }

        with patch.object(indicator.subprocess, 'Popen') as spawn:
            indicator.open_ejected_session(ejected)

        spawn.assert_called_once_with([
            '/usr/bin/ghostty',
            '--title=Codex · harlan-zw/example #24',
            '-e',
            'ssh',
            '-t',
            'hogwild',
            "/home/harlan/.local/bin/codex resume 0f0e0d0c-0b0a-4968-8956-2631d0c871f9 -c 'tui.resume_cwd=\"session\"'",
        ], start_new_session=True)

    def test_does_not_open_an_ejected_terminal_for_an_invalid_session(self):
        ejected = {
            '_tag': 'Ejected',
            'provider': 'opencode',
            'sessionId': 'ses_abc12345;touch_/tmp/pwned',
            'repository': 'harlan-zw/example',
            'itemNumber': 24,
        }

        with patch.object(indicator.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(ValueError, 'Invalid opencode session ID'):
                indicator.open_ejected_session(ejected)

        spawn.assert_not_called()


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
        self.assertEqual(request.full_url, 'https://hogwild.tailcad325.ts.net/api/agents/pause')
        self.assertEqual(request.get_method(), 'POST')
        self.assertEqual(request.get_header('Origin'), 'https://hogwild.tailcad325.ts.net')
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
                return b'{"_tag":"Ejected","provider":"opencode","sessionId":"ses_abc12345","repository":"harlan-zw/example","itemNumber":24}'

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
        self.assertEqual(result, {
            '_tag': 'Ejected',
            'provider': 'opencode',
            'sessionId': 'ses_abc12345',
            'repository': 'harlan-zw/example',
            'itemNumber': 24,
        })
        self.assertEqual(request.full_url, 'https://hogwild.tailcad325.ts.net/api/agents/eject')
        self.assertEqual(request.get_method(), 'POST')
        self.assertEqual(request.data, b'{"taskId":"task-123"}')
        self.assertEqual(request.get_header('Content-type'), 'application/json')
        self.assertEqual(request.get_header('Origin'), 'https://hogwild.tailcad325.ts.net')
        self.assertEqual(request.get_header('Authorization'), 'Basic YWdlbnQ6c2VjcmV0')
        self.assertEqual(timeout, 30)

    def test_reports_the_saved_session_without_resuming_when_eject_settlement_is_delayed(self):
        body = json.dumps({
            'statusCode': 503,
            'data': {
                '_tag': 'EjectDelayed',
                'provider': 'opencode',
                'sessionId': 'ses_abc12345',
                'nextAction': 'Stop Harlan GitHub Agent. Then resume this saved session.',
            },
        }).encode()
        response = urllib.error.HTTPError(
            'https://hogwild.tailcad325.ts.net/api/agents/eject',
            503,
            'Service Unavailable',
            {},
            io.BytesIO(body),
        )

        with tempfile.TemporaryDirectory() as directory:
            password_file = Path(directory) / 'dashboard-password'
            password_file.write_text('secret\n')
            with patch.object(indicator, 'PASSWORD_FILE', password_file), patch.object(
                indicator.urllib.request,
                'urlopen',
                side_effect=response,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    'Saved session ses_abc12345. Stop Harlan GitHub Agent. Then resume this saved session.',
                ):
                    indicator.request_agent_eject('task-123')


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
        choices = indicator.agent_selection_choices(selection_dashboard({
            '_tag': 'Pinned',
            'provider': 'opencode',
            'model': 'zai-coding-plan/glm-5.3-flash',
            'reasoningEffort': None,
        }, 'opencode'))
        selected = [entry['label'] for entry in choices if entry['_tag'] == 'Choice' and entry['selected']]

        self.assertEqual(selected, ['opencode', 'zai-coding-plan/glm-5.3-flash', 'Provider default'])

    def test_marks_following_the_configuration(self):
        choices = indicator.agent_selection_choices(selection_dashboard({'_tag': 'FollowsConfiguration'}, 'codex'))
        selected = [entry['label'] for entry in choices if entry['_tag'] == 'Choice' and entry['selected']]

        self.assertEqual(selected, ['Follow configuration', 'Provider default', 'Provider default'])

    def test_offers_a_way_back_to_the_configuration(self):
        choices = indicator.agent_selection_choices(selection_dashboard({
            '_tag': 'Pinned',
            'provider': 'opencode',
            'model': 'zai-coding-plan/glm-5.3-flash',
            'reasoningEffort': 'high',
        }, 'opencode'))
        follow = next(
            entry for entry in choices
            if entry['_tag'] == 'Choice' and entry['label'] == 'Follow configuration'
        )

        self.assertEqual(follow['selection'], {'_tag': 'FollowsConfiguration'})
        self.assertFalse(follow['selected'])

    def test_automatic_uses_the_configured_provider_order(self):
        choices = indicator.agent_selection_choices(selection_dashboard({
            '_tag': 'Pinned',
            'provider': 'codex',
            'model': None,
            'reasoningEffort': None,
        }, 'codex'))
        automatic = next(
            entry for entry in choices
            if entry['_tag'] == 'Choice' and entry['label'] == 'Automatic'
        )

        self.assertEqual(automatic['selection'], {
            '_tag': 'Automatic',
            'order': ['opencode', 'codex'],
        })

    def test_lists_the_configured_provider_models_while_following_the_configuration(self):
        choices = indicator.agent_selection_choices(selection_dashboard({'_tag': 'FollowsConfiguration'}, 'opencode'))
        models = [
            entry['selection']['model']
            for entry in choices
            if entry['_tag'] == 'Choice' and entry['selection'].get('_tag') == 'Pinned' and 'model' in entry['selection']
        ]

        self.assertIn('zai-coding-plan/glm-5.3-flash', models)
        self.assertNotIn('gpt-5.6-luna', models)

    def test_offers_only_the_models_of_the_selected_provider(self):
        choices = indicator.agent_selection_choices(selection_dashboard({
            '_tag': 'Pinned',
            'provider': 'codex',
            'model': None,
            'reasoningEffort': None,
        }, 'codex'))
        models = [
            entry['selection']['model']
            for entry in choices
            if entry['_tag'] == 'Choice'
            and 'model' in entry['selection']
            and entry['selection'].get('provider') == 'codex'
        ]

        self.assertIn('gpt-5.6-luna', models)
        self.assertNotIn('zai-coding-plan/glm-5.3-flash', models)

    def test_switching_provider_clears_the_model_and_reasoning_effort(self):
        choices = indicator.agent_selection_choices(selection_dashboard({
            '_tag': 'Pinned',
            'provider': 'codex',
            'model': 'gpt-5.6-luna',
            'reasoningEffort': 'max',
        }, 'codex'))
        opencode = next(
            entry for entry in choices
            if entry['_tag'] == 'Choice' and entry['label'] == 'opencode'
        )

        self.assertEqual(
            opencode['selection'],
            {'_tag': 'Pinned', 'provider': 'opencode', 'model': None, 'reasoningEffort': None},
        )

    def test_lists_nothing_without_a_selection(self):
        self.assertEqual(indicator.agent_selection_choices(None), [])
        self.assertEqual(indicator.agent_selection_choices({}), [])

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
        self.assertEqual(request.full_url, 'https://hogwild.tailcad325.ts.net/api/agents/select')
        self.assertEqual(request.get_method(), 'POST')
        self.assertEqual(request.data, b'{"provider":"opencode","model":null,"reasoningEffort":null}')
        self.assertEqual(request.get_header('Content-type'), 'application/json')
        self.assertEqual(request.get_header('Origin'), 'https://hogwild.tailcad325.ts.net')
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

    def test_formats_an_opencode_command_and_validates_its_session(self):
        session_id = 'ses_fc1f02fd3ffeCm7SwBkWsH6YGb'
        self.assertEqual(watch.validate_session_id('opencode', session_id), session_id)
        with self.assertRaisesRegex(ValueError, 'Invalid opencode session ID'):
            watch.validate_session_id('opencode', '../session')

        self.assertEqual(watch.format_opencode_part({
            'type': 'tool',
            'tool': 'bash',
            'state': {
                'status': 'completed',
                'input': {'command': 'pnpm test'},
                'output': 'passed',
                'metadata': {'exit': 0},
            },
        }), '$ pnpm test\n[exit 0]\npassed')

    def test_loads_an_opencode_session_from_its_read_only_store(self):
        session_id = 'ses_fc1f02fd3ffeCm7SwBkWsH6YGb'
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'opencode.db'
            connection = sqlite3.connect(database)
            connection.executescript('''
                CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT);
                CREATE TABLE message (
                    id TEXT PRIMARY KEY,
                    session_id TEXT,
                    time_created INTEGER,
                    data TEXT
                );
                CREATE TABLE part (
                    id TEXT PRIMARY KEY,
                    message_id TEXT,
                    time_created INTEGER,
                    time_updated INTEGER,
                    data TEXT
                );
            ''')
            connection.execute(
                'INSERT INTO session VALUES (?, ?, ?)',
                (session_id, 'Review #24', '/tmp/example'),
            )
            connection.execute(
                'INSERT INTO message VALUES (?, ?, ?, ?)',
                ('msg_1', session_id, 1, '{"role":"assistant","finish":"stop"}'),
            )
            connection.execute(
                'INSERT INTO part VALUES (?, ?, ?, ?, ?)',
                ('part_1', 'msg_1', 2, 3, '{"type":"text","text":"Done."}'),
            )
            connection.commit()
            connection.close()

            session = watch.load_opencode_session(session_id, database)

        self.assertEqual(session['info'], {'title': 'Review #24', 'directory': '/tmp/example'})
        self.assertEqual(watch.format_opencode_part(watch.opencode_parts(session)[0]), 'Agent\nDone.')
        self.assertTrue(watch.opencode_session_complete(session))

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

    def test_first_opencode_poll_tick_skips_history_before_the_initial_window(self):
        session_id = 'ses_fc1f02fd3ffeCm7SwBkWsH6YGb'
        parts = [
            {'id': f'part_{index}', 'type': 'text', 'text': f'message {index:03d}'}
            for index in range(100)
        ]

        def message(finish):
            return {'id': 'msg_1', 'info': {'role': 'assistant', 'finish': finish}, 'parts': parts}

        sessions = iter([
            {'info': {'title': 'Review #24', 'directory': '/tmp/example'}, 'messages': [message(None)]},
            {'info': {'title': 'Review #24', 'directory': '/tmp/example'}, 'messages': [message('stop')]},
        ])
        output = io.StringIO()
        console = watch.Console(file=output, force_terminal=False, width=200)

        with patch.object(watch, 'load_opencode_session', side_effect=lambda _id: next(sessions)), \
                patch.object(watch.time, 'sleep'), \
                patch.object(watch, 'Console', return_value=console), \
                patch.object(watch, 'input', lambda *_args: None):
            watch.watch_opencode(session_id)

        self.assertEqual(output.getvalue().count('message 005'), 0)
        self.assertEqual(output.getvalue().count('message 099'), 1)


if __name__ == '__main__':
    unittest.main()
