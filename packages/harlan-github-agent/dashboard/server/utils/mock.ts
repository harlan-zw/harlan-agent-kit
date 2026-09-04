import type { H3Event } from 'h3'
import type { DashboardSnapshot } from '../../../src/types.ts'
import { randomBytes } from 'node:crypto'
import { createError } from 'h3'
import { dashboardSnapshot, pullRequestItem } from '../../../test/fixtures.ts'

/**
 * A dev-only stand-in for the service, so the dashboard has state to render
 * without the real controller. Never served from `.output/public`: the service
 * only ever serves that directory, and every handler here 404s outside dev.
 *
 * Scenario via `DASHBOARD_MOCK_SCENARIO`: `default`, `paused`, `stale`, `calm`.
 */
export function assertDevMock(event: H3Event): void {
  if (!import.meta.dev) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found', data: { path: event.path } })
  }
}

const hex = (seed: string): string => seed.repeat(64).slice(0, 64)

/** Task IDs are 64 hex characters, so Cancel and Eject validate them like the controller does. */
export const mockTaskId = (): string => randomBytes(32).toString('hex')
const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()
const daysAhead = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString()

function fixture(): DashboardSnapshot {
  const nuxtSeo = 'harlan-zw/nuxt-seo'
  const unhead = 'unjs/unhead'
  const reviewPullRequest = pullRequestItem({
    repository: nuxtSeo,
    number: 412,
    title: 'fix(sitemap): honour trailing slash on nested routes',
    author: 'harlan-zw',
    url: `https://github.com/${nuxtSeo}/pull/412`,
    headSha: '2670f98e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
    headRef: 'fix/sitemap-trailing-slash',
    mergeState: 'clean',
  })
  const contributorPullRequest = pullRequestItem({
    repository: nuxtSeo,
    number: 418,
    title: 'feat(robots): allow per-route disallow rules',
    author: 'octocat',
    url: `https://github.com/${nuxtSeo}/pull/418`,
    headSha: 'b348f3551a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
    headRef: 'feat/per-route-disallow',
    headRepository: 'octocat/nuxt-seo',
    mergeState: 'clean',
  })
  return dashboardSnapshot({
    status: 'degraded',
    mutationsEnabled: true,
    serviceUpdate: {
      _tag: 'Available',
      deployedCommit: '4f57e66b7d1c2e3f4a5b6c7d8e9f001122334455',
      latestCommit: 'e98866d07987ca2390299382c1a8352bd016e741',
      checkedAt: minutesAgo(2),
    },
    agentStart: { _tag: 'Available' },
    openPullRequests: 5,
    providerCapacities: [
      { provider: 'codex', reservePercent: 20, capacity: { _tag: 'Available', usedPercent: 63.4, resetsAt: daysAhead(3) } },
      { provider: 'opencode', reservePercent: 0, capacity: { _tag: 'Unpublished' } },
    ],
    repositories: [
      { github: nuxtSeo, enabled: true, writesEnabled: true, ownership: 'owned', lastAttemptAt: minutesAgo(1), lastSuccessAt: minutesAgo(1), lastError: null, paused: false, subjectCount: 4 },
      { github: unhead, enabled: true, writesEnabled: true, ownership: 'maintained', lastAttemptAt: minutesAgo(2), lastSuccessAt: minutesAgo(35), lastError: 'GitHub answered 403 for unjs/unhead.', paused: false, subjectCount: 2 },
      { github: 'harlan-zw/harlan-agent-kit', enabled: true, writesEnabled: false, ownership: 'owned', lastAttemptAt: minutesAgo(1), lastSuccessAt: minutesAgo(1), lastError: null, paused: false, subjectCount: 1 },
    ],
    items: [
      { ...reviewPullRequest, revisionId: hex('a'), observedAt: minutesAgo(3), dismissed: false, approval: { _tag: 'NotRequired' } },
      { ...contributorPullRequest, revisionId: hex('b'), observedAt: minutesAgo(8), dismissed: false, approval: { _tag: 'ReviewRequired' } },
    ],
    agents: [
      {
        _tag: 'ActiveAgent',
        id: hex('1'),
        provider: 'codex',
        role: 'review_fix',
        session: { _tag: 'Connected', id: '0f7d1c2e-1111-4222-8333-444455556666' },
        repository: nuxtSeo,
        repositoryUrl: `https://github.com/${nuxtSeo}`,
        subjectKind: 'pull_request',
        itemNumber: 412,
        title: reviewPullRequest.title,
        author: 'harlan-zw',
        subjectUrl: reviewPullRequest.url,
        headSha: reviewPullRequest.headSha,
        commitUrl: `https://github.com/${nuxtSeo}/commit/${reviewPullRequest.headSha}`,
        startedAt: minutesAgo(4),
        updatedAt: minutesAgo(0),
        progress: { percent: 40, label: 'Repair', since: minutesAgo(2) },
        activity: [
          { _tag: 'Command', at: minutesAgo(3), command: 'pnpm test --filter sitemap', output: 'Tests  2 failed | 41 passed (43)', exitCode: 1 },
          { _tag: 'FileChange', at: minutesAgo(1), changes: [{ path: 'src/runtime/sitemap/urlset.ts', kind: 'update' }] },
        ],
        state: { _tag: 'Working', workerId: 'lease-1', fence: 3, leaseExpiresAt: daysAhead(0.01) },
      },
    ],
    incidents: [
      {
        id: 'incident-1',
        scope: { _tag: 'Repository', repository: unhead },
        kind: 'github_access',
        severity: 'error',
        message: 'GitHub answered 403 for unjs/unhead. The installation may have lost access.',
        operation: 'poll',
        recovery: { _tag: 'Retrying', attempt: 2, nextAttemptAt: daysAhead(0.002) },
        occurrences: 3,
        firstSeenAt: minutesAgo(35),
        lastSeenAt: minutesAgo(2),
      },
    ],
    queue: [
      { kind: 'pull_request', position: 1, revisionId: hex('a'), repository: nuxtSeo, repositoryUrl: `https://github.com/${nuxtSeo}`, number: 412, title: reviewPullRequest.title, author: 'harlan-zw', subjectUrl: reviewPullRequest.url, headSha: reviewPullRequest.headSha, commitUrl: `https://github.com/${nuxtSeo}/commit/${reviewPullRequest.headSha}`, createdAt: minutesAgo(40), updatedAt: minutesAgo(4), state: { _tag: 'Active', work: 'review_fix' } },
      { kind: 'pull_request', position: 2, revisionId: hex('b'), repository: nuxtSeo, repositoryUrl: `https://github.com/${nuxtSeo}`, number: 418, title: contributorPullRequest.title, author: 'octocat', subjectUrl: contributorPullRequest.url, headSha: contributorPullRequest.headSha, commitUrl: `https://github.com/${nuxtSeo}/commit/${contributorPullRequest.headSha}`, createdAt: minutesAgo(90), updatedAt: minutesAgo(8), state: { _tag: 'AwaitingApproval', kind: 'review' } },
      { kind: 'issue', position: 3, revisionId: hex('c'), repository: unhead, repositoryUrl: `https://github.com/${unhead}`, number: 731, title: 'useHead drops meta tags after client navigation', author: 'contributor', subjectUrl: `https://github.com/${unhead}/issues/731`, createdAt: minutesAgo(120), updatedAt: minutesAgo(15), state: { _tag: 'AwaitingApproval', kind: 'issue_work' } },
      { kind: 'pull_request', position: 4, revisionId: hex('d'), repository: nuxtSeo, repositoryUrl: `https://github.com/${nuxtSeo}`, number: 420, title: 'chore(deps): bump vite to 7.2', author: 'renovate', subjectUrl: `https://github.com/${nuxtSeo}/pull/420`, headSha: 'ca5595d11a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d', commitUrl: `https://github.com/${nuxtSeo}/commit/ca5595d1`, createdAt: minutesAgo(30), updatedAt: minutesAgo(30), state: { _tag: 'Queued', work: 'adversarial_review' } },
      { kind: 'issue', position: 5, revisionId: hex('e'), repository: nuxtSeo, repositoryUrl: `https://github.com/${nuxtSeo}`, number: 399, title: 'Schema.org breadcrumbs miss the home crumb', author: 'harlan-zw', subjectUrl: `https://github.com/${nuxtSeo}/issues/399`, createdAt: minutesAgo(200), updatedAt: minutesAgo(20), state: { _tag: 'Queued', work: 'issue_work' } },
      { kind: 'pull_request', position: 6, revisionId: hex('f'), repository: nuxtSeo, repositoryUrl: `https://github.com/${nuxtSeo}`, number: 421, title: 'feat(og-image): satori font subsetting', author: 'harlan-zw', subjectUrl: `https://github.com/${nuxtSeo}/pull/421`, headSha: '4ffae6691a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d', commitUrl: `https://github.com/${nuxtSeo}/commit/4ffae669`, createdAt: minutesAgo(10), updatedAt: minutesAgo(10), state: { _tag: 'Pending', reason: 'Blocked on a draft.' } },
    ],
    tasks: [
      { id: hex('1'), kind: 'review_fix', repository: nuxtSeo, pullRequestNumber: 412, revisionId: hex('a'), state: { _tag: 'Running', workerId: 'lease-1', fence: 3, leaseExpiresAt: daysAhead(0.01) }, updatedAt: minutesAgo(0), progress: { percent: 40, label: 'Repair' } },
      { id: hex('2'), kind: 'resolve_conflict', repository: nuxtSeo, pullRequestNumber: 405, revisionId: hex('9'), state: { _tag: 'Completed', evidence: 'Rebased onto main. 3 files, checks green.' }, updatedAt: minutesAgo(50), progress: { percent: 100, label: 'Done' } },
      { id: hex('3'), kind: 'issue_work', repository: unhead, issueNumber: 702, revisionId: hex('8'), state: { _tag: 'Failed', reason: 'The verification command exited 1 twice.' }, updatedAt: minutesAgo(140), progress: { percent: 100, label: 'Failed' } },
    ],
    routines: [
      { id: `${nuxtSeo}:pr-triage`, repository: nuxtSeo, name: 'pr-triage', crons: ['0 9 * * 1-5'], timeZone: 'Australia/Sydney', mode: 'report', enabled: true, specSha: hex('7'), lastRunAt: minutesAgo(600), trackingIssueNumber: 380, updatedAt: minutesAgo(600) },
    ],
    routineRuns: [
      { id: 'run-1', routineId: `${nuxtSeo}:pr-triage`, repository: nuxtSeo, name: 'pr-triage', scheduledFor: minutesAgo(600), specSha: hex('7'), mode: 'report', state: { _tag: 'Completed', evidence: 'Ranked 6 open pull requests.' }, fence: 1, attempts: 1, progress: { percent: 100, label: 'Done' }, usage: { _tag: 'Unavailable' }, createdAt: minutesAgo(600), updatedAt: minutesAgo(590), candidates: [], activity: [{ _tag: 'Command', at: minutesAgo(598), command: 'gh pr list --state open', output: '6 pull requests', exitCode: 0 }], reportState: 'Published' },
    ],
    batches: [
      {
        id: hex('b1'),
        repository: nuxtSeo,
        state: { _tag: 'Running', workerId: 'lease-2', fence: 1, leaseExpiresAt: daysAhead(0.1) },
        issues: [
          { taskId: hex('c1'), issueNumber: 795, title: 'Runner doc misses the burst-registration DNS failure', body: '', triageSummary: null, relatedIssues: [796], target: 'docs/ops/github-actions-runner.md' },
          { taskId: hex('c2'), issueNumber: 796, title: 'DataForSEO refusals warn once per day', body: '', triageSummary: null, relatedIssues: [795], target: 'layers/pro/dataforseo/server/utils/pipeline.ts' },
          { taskId: hex('c3'), issueNumber: 797, title: 'Public token callers cannot resolve a Site by URL', body: '', triageSummary: null, relatedIssues: [], target: 'layers/pro/sites/server/utils/require-site-access.ts' },
        ],
        units: [
          { id: 'unit-0', position: 0, primaryTaskId: hex('c1'), issueNumbers: [795, 796], dependsOnUnitId: null, rationale: 'Both change the DataForSEO pipeline and its runbook.', state: { _tag: 'Published', pullRequestNumber: 801, headRef: 'fix/issue-795', headSha: hex('5') } },
          { id: 'unit-1', position: 1, primaryTaskId: hex('c3'), issueNumbers: [797], dependsOnUnitId: 'unit-0', rationale: 'Reuses the site lookup the first unit extracts.', state: { _tag: 'Running' } },
        ],
        createdAt: minutesAgo(25),
        updatedAt: minutesAgo(1),
      },
      {
        id: hex('b2'),
        repository: unhead,
        state: { _tag: 'Running', workerId: 'lease-3', fence: 1, leaseExpiresAt: daysAhead(0.1) },
        issues: [
          { taskId: hex('c4'), issueNumber: 30, title: 'fetch-head throws for expected upstream failures', body: '', triageSummary: null, relatedIssues: [31], target: 'layers/tools/server/api/tools/fetch-head.get.ts' },
          { taskId: hex('c5'), issueNumber: 31, title: 'fetch-head 5xx mapping', body: '', triageSummary: null, relatedIssues: [30], target: 'layers/tools/server/api/tools/fetch-head.get.ts' },
        ],
        units: null,
        createdAt: minutesAgo(2),
        updatedAt: minutesAgo(2),
      },
    ],
  })
}

function scenario(base: DashboardSnapshot): DashboardSnapshot {
  switch (process.env.DASHBOARD_MOCK_SCENARIO) {
    case 'paused':
      return { ...base, agentControl: { _tag: 'Paused', pausedAt: minutesAgo(5), safeToRestart: false }, agentStart: { _tag: 'Paused' } }
    case 'calm':
      return { ...base, status: 'ready', incidents: [], queue: base.queue.filter(entry => entry.state._tag !== 'AwaitingApproval'), repositories: base.repositories.map(repository => ({ ...repository, lastError: null })) }
    default:
      return base
  }
}

let state: DashboardSnapshot = scenario(fixture())

export function currentMockSnapshot(): DashboardSnapshot {
  const generatedAt = process.env.DASHBOARD_MOCK_SCENARIO === 'stale' ? minutesAgo(2) : new Date().toISOString()
  return { ...state, generatedAt }
}

export function updateMock(patch: (current: DashboardSnapshot) => DashboardSnapshot): DashboardSnapshot {
  state = patch(state)
  return currentMockSnapshot()
}

/*
 * Finished Review runs, so History has evidence to open and Agent feedback to
 * record. Appended for the History page; the fixture above is unchanged.
 */
type MockReviewAgent = Extract<DashboardSnapshot['agents'][number], { _tag: 'ReviewAgent' }>

function historyReviewAgents(): MockReviewAgent[] {
  const nuxtSeo = 'harlan-zw/nuxt-seo'
  const kit = 'harlan-zw/harlan-agent-kit'
  const currentHead = '2670f98e1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d'
  const oldHead = 'b348f3550000000000000000000000000000000d'
  const kitHead = '4ffae66900000000000000000000000000000000'
  return [
    {
      _tag: 'ReviewAgent',
      role: 'adversarial_review',
      id: 'review-1',
      repository: nuxtSeo,
      repositoryUrl: `https://github.com/${nuxtSeo}`,
      pullRequestNumber: 412,
      revisionId: hex('a'),
      headSha: currentHead,
      provider: 'codex',
      sessionId: '0f7d1c2e-1111-4222-8333-444455556666',
      model: 'gpt-5.6-sol',
      agentVersion: '1.4.2',
      skillDigest: hex('5'),
      startedAt: minutesAgo(31),
      completedAt: minutesAgo(25),
      updatedAt: minutesAgo(25),
      title: 'fix(sitemap): honour trailing slash on nested routes',
      author: 'harlan-zw',
      subjectUrl: `https://github.com/${nuxtSeo}/pull/412`,
      commitUrl: `https://github.com/${nuxtSeo}/commit/${currentHead}`,
      pullRequestStatus: { _tag: 'Open' },
      usage: { _tag: 'Available', input: 184_200, cachedInput: 121_000, cacheWrite: 9_400, output: 6_100, reasoning: 22_800 },
      gates: {
        merge: { _tag: 'Passed', evidence: [] },
        review: { _tag: 'Passed', evidence: [] },
        ci: { _tag: 'Passed', evidence: [] },
      },
      outcome: { _tag: 'Ready', confidence: 92 },
      findings: [{ _tag: 'Fixed', summary: 'Nested routes lost their trailing slash in the sitemap index.' }],
      feedback: null,
      publications: [{
        id: 'publication-1',
        reviewRunId: 'review-1',
        body: '',
        bodySha256: hex('6'),
        at: minutesAgo(25),
        result: { _tag: 'Published', githubCommentId: 3312001, url: `https://github.com/${nuxtSeo}/pull/412#issuecomment-3312001` },
      }],
    },
    {
      _tag: 'ReviewAgent',
      role: 'adversarial_review',
      id: 'review-2',
      repository: nuxtSeo,
      repositoryUrl: `https://github.com/${nuxtSeo}`,
      pullRequestNumber: 418,
      revisionId: hex('0'),
      headSha: oldHead,
      provider: 'opencode',
      sessionId: 'ses_4c1d9e2f7a6b8c3d',
      model: 'zai-coding-plan/glm-5.3',
      agentVersion: '1.4.2',
      skillDigest: hex('5'),
      startedAt: minutesAgo(103),
      completedAt: minutesAgo(95),
      updatedAt: minutesAgo(95),
      title: 'feat(robots): allow per-route disallow rules',
      author: 'octocat',
      subjectUrl: `https://github.com/${nuxtSeo}/pull/418`,
      commitUrl: `https://github.com/${nuxtSeo}/commit/${oldHead}`,
      pullRequestStatus: { _tag: 'Open' },
      usage: { _tag: 'Available', input: 96_400, cachedInput: 40_100, cacheWrite: 3_200, output: 4_800, reasoning: 15_300 },
      gates: {
        merge: { _tag: 'Passed', evidence: [] },
        review: { _tag: 'Failed', reason: 'One open finding requires Repair.', evidence: [] },
        ci: { _tag: 'Pending', reason: 'Two required check runs are still running.', evidence: [] },
      },
      outcome: { _tag: 'Blocked' },
      findings: [
        { _tag: 'Open', summary: 'Disallow rules ignore route rules declared in nuxt.config.', nextAction: 'Read routeRules before building the robots entries.', resolution: 'Repair' },
        { _tag: 'Fixed', summary: 'The new option was missing from the module type.' },
      ],
      feedback: null,
      publications: [{
        id: 'publication-2',
        reviewRunId: 'review-2',
        body: '',
        bodySha256: hex('6'),
        at: minutesAgo(95),
        result: { _tag: 'Published', githubCommentId: 3311870, url: `https://github.com/${nuxtSeo}/pull/418#issuecomment-3311870` },
      }],
    },
    {
      _tag: 'ReviewAgent',
      role: 'adversarial_review',
      id: 'review-3',
      repository: kit,
      repositoryUrl: `https://github.com/${kit}`,
      pullRequestNumber: 122,
      revisionId: hex('3'),
      headSha: kitHead,
      provider: 'codex',
      sessionId: '7b2e4d10-2222-4333-8444-555566667777',
      model: 'gpt-5.6-terra',
      agentVersion: '1.4.1',
      skillDigest: hex('4'),
      startedAt: minutesAgo(426),
      completedAt: minutesAgo(420),
      updatedAt: minutesAgo(400),
      title: 'fix(agent): unblock automated PR repairs',
      author: 'harlan-zw',
      subjectUrl: `https://github.com/${kit}/pull/122`,
      commitUrl: `https://github.com/${kit}/commit/${kitHead}`,
      pullRequestStatus: { _tag: 'Merged', mergedAt: minutesAgo(380) },
      usage: { _tag: 'Unavailable' },
      gates: {
        merge: { _tag: 'Passed', evidence: [] },
        review: { _tag: 'Passed', evidence: [] },
        ci: { _tag: 'Pending', reason: 'The lint check run had not reported.', evidence: [] },
      },
      outcome: { _tag: 'Pending' },
      findings: [],
      feedback: { _tag: 'Useful', reason: 'Caught the missing null guard before merge.', updatedAt: minutesAgo(400) },
      publications: [],
    },
  ]
}

state = { ...state, agents: [...state.agents, ...historyReviewAgents()] }
