import type { AgentRuntimeSource } from '../src/agent-profile.ts'
import type { AgentEvent, AgentProvider, AgentProviderName, AgentTurnRequest } from '../src/agent-provider.ts'
import type { AgentProfile, DashboardSnapshot, GitHubIssueItem, GitHubPullRequestItem, RepositoryMapping } from '../src/types.ts'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'

/** One fixed Agent runtime, for a worker that never switches mid test. */
export function agentRuntime(profile: AgentProfile, provider: AgentProvider): AgentRuntimeSource {
  return () => ({ profile, provider })
}

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
    maxOpenPullRequests: null,
    pullRequestReview: true,
    conflictResolution: true,
    takeOwnership: { _tag: 'Disabled' },
    ...overrides,
  }
}

export function issueItem(overrides: Partial<GitHubIssueItem> = {}): GitHubIssueItem {
  return {
    kind: 'issue',
    approvalLabels: [],
    contentDigest: '0'.repeat(64),
    routineFiled: false,
    routineTracking: false,
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
    baseRef: 'main',
    headSha: 'abc123',
    headRepository: 'harlan-zw/example',
    headRef: 'fix/broken-thing',
    maintainerCanModify: true,
    mergeState: 'conflicting',
    purpose: { _tag: 'Change' },
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
    restartRequest: null,
    selectionMode: 'auto',
    openPullRequests: 0,
    maxOpenPullRequests: 8,
    agentProfile: CODEX_AGENT_PROFILE,
    agentSelection: { _tag: 'FollowsConfiguration' },
    agentStart: { _tag: 'WritesDisabled' },
    agentProviderOrder: ['opencode', 'codex'],
    agentModels: {
      codex: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
      opencode: ['zai-coding-plan/glm-5.3-flash'],
    },
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    providerCapacities: [],
    providerCircuits: [],
    agents: [],
    incidents: [],
    queue: [],
    repositories: [],
    items: [],
    tasks: [],
    routines: [],
    routineRuns: [],
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
