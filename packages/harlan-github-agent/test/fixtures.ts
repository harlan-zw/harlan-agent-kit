import type { DashboardSnapshot, GitHubIssueSubject, GitHubPullRequestSubject, RepositoryMapping } from '../src/types.ts'
import { CODEX_WORKER_PROFILE } from '../src/codex-worker-profile.ts'

export function repositoryMapping(overrides: Partial<RepositoryMapping> = {}): RepositoryMapping {
  return {
    github: 'harlan-zw/example',
    checkout: '/home/harlan/pkg/example',
    enabled: true,
    ownership: 'owned',
    defaultBranch: 'main',
    writablePullRequestAuthors: ['harlan-zw'],
    writablePullRequestHeadPrefixes: ['fix/', 'feat/', 'chore/'],
    issueWork: true,
    pullRequestReview: true,
    pullRequestConformance: true,
    conflictResolution: true,
    takeOwnership: { _tag: 'Disabled' },
    ...overrides,
  }
}

export function issueSubject(overrides: Partial<GitHubIssueSubject> = {}): GitHubIssueSubject {
  return {
    kind: 'issue',
    approvalLabels: [],
    repository: 'harlan-zw/example',
    number: 12,
    state: 'open',
    title: 'Broken thing',
    author: 'contributor',
    url: 'https://github.com/harlan-zw/example/issues/12',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  }
}

export function pullRequestSubject(overrides: Partial<GitHubPullRequestSubject> = {}): GitHubPullRequestSubject {
  return {
    kind: 'pull_request',
    approvalLabels: [],
    repository: 'harlan-zw/example',
    number: 24,
    state: 'open',
    mergedAt: null,
    title: 'Fix the broken thing',
    author: 'harlan-zw',
    url: 'https://github.com/harlan-zw/example/pull/24',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    draft: false,
    baseSha: 'base123',
    headSha: 'abc123',
    headRepository: 'harlan-zw/example',
    headRef: 'fix/broken-thing',
    maintainerCanModify: true,
    mergeState: 'conflicting',
    priorAutomatedReview: { _tag: 'None' },
    ...overrides,
  }
}

export function dashboardSnapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    generatedAt: '2026-08-13T01:00:00.000Z',
    status: 'ready',
    mutationsEnabled: false,
    agentControl: { _tag: 'Running' },
    workerProfile: CODEX_WORKER_PROFILE,
    agents: [],
    queue: [],
    repositories: [],
    subjects: [],
    tasks: [],
    ...overrides,
  }
}
