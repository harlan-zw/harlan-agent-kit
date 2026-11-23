import type { AgentRuntimeSource } from '../src/agent-profile.ts'
import type { AgentEvent, AgentProvider, AgentProviderName, AgentTurnRequest } from '../src/agent-provider.ts'
import type { HeadChangedFiles } from '../src/auto-merge.ts'
import type { GitHubAgentSource } from '../src/github-agent-source.ts'
import type { PullRequestFile } from '../src/merge-risk.ts'
import type { PublicTextGuard } from '../src/public-text.ts'
import type { AgentProfile, DashboardSnapshot, GitHubIssueItem, GitHubPullRequestItem, RepositoryMapping } from '../src/types.ts'
import type { GitHubOwnershipEvidence } from '../src/worker-github-evidence.ts'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { ok } from '../src/result.ts'

/** One modified file, the shape GitHub's pull request file list returns. */
export function changedFile(path: string, overrides: Partial<PullRequestFile> = {}): PullRequestFile {
  return { additions: 1, deletions: 0, path, previousFilename: null, status: 'modified', ...overrides }
}

/** The changed files Auto merge read for one head commit. The default is one ordinary source file. */
export function headChangedFiles(files: PullRequestFile[] = [changedFile('src/index.ts')], headSha = 'abc123'): HeadChangedFiles {
  return { _tag: 'Read', headSha, files }
}

/** A GitHub source that lists the same changed files for every pull request. */
export function changedFilesSource(files: PullRequestFile[] = [changedFile('src/index.ts')]): Pick<GitHubAgentSource, 'listPullRequestFiles'> {
  return { listPullRequestFiles: async () => ok(files) }
}

/** A guard with nothing to redact, for tests about something other than private details. */
export const testPublicText: PublicTextGuard = {
  details: { paths: [], hosts: [] },
  report: () => {
    throw new Error('A test without private details reported a redaction.')
  },
}

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
    autoMerge: { _tag: 'Labelled', minimumConfidence: null },
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

export function githubOwnershipEvidence(overrides: Partial<GitHubOwnershipEvidence> = {}): GitHubOwnershipEvidence {
  return {
    observedAt: '2026-11-01T07:00:00.000Z',
    issues: { _tag: 'Available', entries: [], truncated: false },
    pullRequests: { _tag: 'Available', entries: [], truncated: false },
    ownership: {
      _tag: 'Available',
      issues: { _tag: 'Available', entries: [], truncated: false },
      pullRequests: { _tag: 'Available', entries: [], truncated: false },
    },
    ...overrides,
  }
}

export function githubOwnershipSource(evidence = githubOwnershipEvidence()) {
  return { collectOwnership: async () => evidence }
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
    controllerOwned: false,
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
    serviceUpdate: { _tag: 'Current', deployedCommit: 'a'.repeat(40), latestCommit: 'a'.repeat(40), checkedAt: '2026-08-13T01:00:00.000Z' },
    selectionMode: 'auto',
    openPullRequests: 0,
    maxOpenPullRequests: 8,
    triageDecisions: { reviewRequired: 0, reviewSkipped: 0, couldNotDecide: 0 },
    triageSkips: [],
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
    githubRateLimits: [],
    providerCircuits: [],
    agents: [],
    incidents: [],
    repairRecoveryCandidates: [],
    queue: [],
    repositories: [],
    items: [],
    tasks: [],
    routines: [],
    routineRuns: [],
    batches: [],
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

/** A turn ledger that keeps nothing, for tests about other behavior. */
export const agentTurnLedger = {
  recordAgentTurn: () => undefined,
  agentSessionTotal: () => null,
}
