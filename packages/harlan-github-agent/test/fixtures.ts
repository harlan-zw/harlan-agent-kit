import type { AgentEvent, AgentProvider, AgentProviderName, AgentTurnRequest } from '../src/agent-provider.ts'
import type { DashboardSnapshot, GitHubIssueItem, GitHubPullRequestItem, RepositoryMapping } from '../src/types.ts'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'

export function repositoryMapping(overrides: Partial<RepositoryMapping> = {}): RepositoryMapping {
  return {
    github: 'harlan-zw/example',
    checkout: '/home/harlan/pkg/example',
    enabled: true,
    authentication: 'app',
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

export function issueItem(overrides: Partial<GitHubIssueItem> = {}): GitHubIssueItem {
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

export function pullRequestItem(overrides: Partial<GitHubPullRequestItem> = {}): GitHubPullRequestItem {
  return {
    kind: 'pull_request',
    approvalLabels: [],
    autoMerge: false,
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
    agentProfile: CODEX_AGENT_PROFILE,
    agents: [],
    incidents: [],
    queue: [],
    repositories: [],
    items: [],
    tasks: [],
    ...overrides,
  }
}

export interface ProviderCapture {
  requests: AgentTurnRequest[]
}

/**
 * One provider that replays a fixed event stream and records every request,
 * so worker tests assert behaviour instead of a vendor transport.
 */
export function stubProvider(
  events: AgentEvent[],
  capture: ProviderCapture = { requests: [] },
  name: AgentProviderName = 'codex',
): AgentProvider {
  return {
    name,
    runTurn: (request) => {
      capture.requests.push(request)
      return (async function* () {
        yield* events
      })()
    },
  }
}

/** The usual shape of a successful turn: a session, one command, one result. */
export function turnEvents(response: unknown, command = 'pnpm test'): AgentEvent[] {
  return [
    { _tag: 'SessionStarted', sessionId: 'session-1' },
    { _tag: 'CommandStarted', command },
    { _tag: 'Message', text: JSON.stringify(response) },
    { _tag: 'TurnCompleted' },
  ]
}
