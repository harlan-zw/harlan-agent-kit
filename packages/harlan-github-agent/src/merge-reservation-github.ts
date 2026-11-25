import type { Octokit } from 'octokit'
import type { GitHubTokenProvider } from './github-auth.ts'
import type { ReservationEvidence, ReservationRun } from './merge-reservation-observation.ts'
import type { RepositoryMapping } from './types.ts'
import { createAuthenticatedClient } from './github-auth.ts'
import { workflowRunSource } from './take-ownership-github.ts'

const openHandoffsQuery = `
  query ReservationHandoffs($owner: String!, $name: String!, $base: String!) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        name
        target {
          oid
          ... on Commit {
            associatedPullRequests(first: 10) {
              nodes { mergedAt mergeCommit { oid } baseRefName baseRepository { nameWithOwner } }
            }
          }
        }
      }
      pullRequests(first: 100, states: OPEN, baseRefName: $base) {
        pageInfo { hasNextPage }
        nodes { number url autoMergeRequest { enabledAt } }
      }
    }
  }
`

interface HandoffSnapshot {
  repository: {
    defaultBranchRef: {
      name: string
      target: {
        oid: string
        associatedPullRequests?: {
          nodes: ({ mergedAt: string | null, mergeCommit: { oid: string } | null, baseRefName: string, baseRepository: { nameWithOwner: string } | null } | null)[]
        }
      }
    } | null
    pullRequests: {
      pageInfo: { hasNextPage: boolean }
      nodes: ({ number: number, url: string, autoMergeRequest: unknown } | null)[]
    }
  } | null
}

type WorkflowRun = Awaited<ReturnType<Octokit['rest']['actions']['listWorkflowRuns']>>['data']['workflow_runs'][number]
const activeStatuses = ['queued', 'in_progress', 'requested', 'pending', 'waiting'] as const

function runEvidence(run: WorkflowRun): ReservationRun {
  return {
    id: run.id,
    sha: run.head_sha,
    startedAt: run.run_started_at ?? run.created_at,
    updatedAt: run.updated_at,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
  }
}

function includeActiveRuns(recent: WorkflowRun[], active: WorkflowRun[]): WorkflowRun[] {
  const runs = new Map(recent.map(run => [run.id, run]))
  for (const run of active) {
    const current = runs.get(run.id)
    if (current === undefined || run.updated_at >= current.updated_at)
      runs.set(run.id, run)
  }
  return [...runs.values()]
}

export function createReservationSource(options: {
  tokens: GitHubTokenProvider
  fetch: typeof globalThis.fetch
  createClient?: Parameters<typeof createAuthenticatedClient>[0]['createClient']
}) {
  return async (repository: RepositoryMapping, signal: AbortSignal): Promise<ReservationEvidence> => {
    const [owner = '', repo = ''] = repository.github.split('/')
    const branch = repository.defaultBranch
    const request = { signal, timeout: 15_000 }
    const client = async (access: 'read' | 'checks_read') => {
      const credential = await options.tokens.getToken(repository.github, access, signal)
      if (credential._tag === 'Err')
        throw new Error(credential.error.message)
      return createAuthenticatedClient({
        repository: repository.github,
        access,
        token: credential.value.token,
        tokens: options.tokens,
        signal,
        userAgent: 'harlan-github-agent',
        ...(options.createClient === undefined ? {} : { createClient: options.createClient }),
      })
    }
    const [repositoryClient, actionsClient] = await Promise.all([client('read'), client('checks_read')])
    const snapshot = (await repositoryClient.graphql<HandoffSnapshot>(openHandoffsQuery, { owner, name: repo, base: branch, request })).repository
    if (snapshot?.defaultBranchRef?.name !== branch || snapshot.pullRequests.pageInfo.hasNextPage)
      throw new Error('The default branch or GitHub auto-merge handoffs could not be verified.')
    const mainSha = snapshot.defaultBranchRef.target.oid
    const mergedAt = snapshot.defaultBranchRef.target.associatedPullRequests?.nodes.find(pull =>
      pull?.mergeCommit?.oid === mainSha && pull.baseRefName === branch
      && pull.baseRepository?.nameWithOwner.toLowerCase() === repository.github.toLowerCase())?.mergedAt ?? null
    const handoffs = snapshot.pullRequests.nodes.flatMap((pull) => {
      if (pull === null || pull.autoMergeRequest === undefined)
        throw new Error('GitHub returned an incomplete auto-merge handoff.')
      return pull.autoMergeRequest === null ? [] : [{ number: pull.number, url: pull.url }]
    })
    const list = (workflow_id: string, event?: 'push') => actionsClient.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id,
      branch,
      per_page: 100,
      ...(event === undefined ? {} : { event }),
      request,
    }).then(response => response.data.workflow_runs)
    const listActive = async () => (await Promise.all(activeStatuses.map(async (status) => {
      const { data } = await actionsClient.rest.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        branch,
        status,
        per_page: 100,
        request,
      })
      if (data.total_count > data.workflow_runs.length)
        throw new Error('GitHub returned incomplete active workflow runs.')
      return data.workflow_runs
    }))).flat()
    const served = options.fetch('https://nuxtseo.com/', { signal, redirect: 'manual', headers: { 'user-agent': 'harlan-github-agent' } })
      .then(async (response) => {
        await response.body?.cancel()
        return response.ok ? response.headers.get('x-release-sha')?.trim().toLowerCase() ?? null : null
      })
      .catch(() => {
        // Missing production evidence must leave the delivery in WouldWait.
        return null
      })
    const [recentCode, recentDeploys, active, servedRevision] = await Promise.all([list('code.yml', 'push'), list('deploy-prod.yml'), listActive(), served])
    const current = await repositoryClient.rest.repos.getBranch({ owner, repo, branch, request })
    if (current.data.commit.sha !== mainSha)
      throw new Error('The default branch changed during the observation.')
    const codeRuns = includeActiveRuns(recentCode, active.filter(run => run.event === 'push'
      && run.path.split('@')[0] === '.github/workflows/code.yml'))
    const deployRuns = includeActiveRuns(recentDeploys, active.filter(run => run.path.split('@')[0] === '.github/workflows/deploy-prod.yml'))
    const activeDocsPolls = includeActiveRuns([], active.filter(run => run.path.split('@')[0] === '.github/workflows/docs-poll.yml')).map(runEvidence)
    const deploys = deployRuns.flatMap<ReservationEvidence['deploys'][number]>((run) => {
      if (run.event === 'workflow_dispatch')
        return [{ run: runEvidence(run), sourceSha: null }]
      const source = workflowRunSource(run.display_title)
      if (run.event === 'workflow_run' && source !== null && source.repository.toLowerCase() === repository.github.toLowerCase() && source.branch === branch)
        return [{ run: runEvidence(run), sourceSha: source.sha }]
      // A complete marker that names a PR or another repository proves
      // this run uses an isolated group. Unknown provenance can still block.
      return run.event === 'workflow_run' && / \[take_ownership:[^:\s\]]+:[^:\s\]]+:[^:\s\]]+:[a-f0-9]{40}\]$/.test(run.display_title)
        ? []
        : [{ run: runEvidence(run), sourceSha: null }]
    })
    return { mainSha, code: codeRuns.map(runEvidence), deploys, activeDocsPolls, handoffs, servedRevision, mergedAt }
  }
}
