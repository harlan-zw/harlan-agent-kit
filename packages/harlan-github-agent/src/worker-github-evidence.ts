import type { Octokit } from 'octokit'
import type { FailedJobContext, GitHubAgentSource, GitHubChecksSnapshot } from './github-agent-source.ts'
import type { GitHubTokenProvider } from './github-auth.ts'
import type { Result } from './result.ts'
import type { GitHubRepositoryAccess, RepositoryMapping } from './types.ts'
import { redactSecrets } from './agent-activity.ts'
import { createAuthenticatedClient } from './github-auth.ts'
import { err, ok } from './result.ts'

const maximumEntries = 20
const maximumText = 500
const safeText = (text: string): string => redactSecrets(text).slice(0, maximumText)

type JobContextEvidence = { _tag: 'Available', job: FailedJobContext } | { _tag: 'Unavailable', reason: string }
type JobLogSnapshot = { _tag: 'NotRequested' } | { _tag: 'Unavailable', reason: string } | { _tag: 'Available', jobs: Array<{ runId: number, evidence: JobContextEvidence }>, truncated: boolean, logScope: string }
type RepairGitHubEvidence = { _tag: 'Unavailable', reason: string } | { _tag: 'Available', jobs: Array<{ check: string, evidence: JobContextEvidence }>, truncated: boolean }

type Section = { _tag: 'Available', entries: Record<string, string | number | null>[], truncated: boolean } | { _tag: 'Unavailable', reason: string }
export interface RoutineGitHubEvidence {
  observedAt: string
  issues: Section
  pullRequests: Section
  workflowRuns: Section
  deployments: Section
  deploymentStatuses: Array<{ deploymentId: number, evidence: Section }>
  jobLogs: JobLogSnapshot
}
export interface RoutineGitHubEvidenceSource {
  collect: (mapping: RepositoryMapping, signal: AbortSignal, includeSuccessfulJobs?: boolean) => Promise<RoutineGitHubEvidence>
}

type Read = (path: string) => Promise<Result<unknown, string>>

function section(input: unknown, fields: readonly string[], excludePullRequests = false): Section {
  if (!Array.isArray(input))
    return { _tag: 'Unavailable', reason: 'GitHub returned an invalid metadata list.' }
  if (input.some(value => typeof value !== 'object' || value === null || Array.isArray(value)))
    return { _tag: 'Unavailable', reason: 'GitHub returned an invalid metadata entry.' }
  const entries: Record<string, unknown>[] = input.filter(value => !excludePullRequests || !('pull_request' in value))
  const identity = fields[0]!
  if (entries.some(value => ['number', 'id'].includes(identity) ? typeof value[identity] !== 'number' || !Number.isSafeInteger(value[identity]) || (value[identity] as number) <= 0 : typeof value[identity] !== 'string'))
    return { _tag: 'Unavailable', reason: 'GitHub returned an invalid metadata identity.' }
  const selected = entries.slice(0, maximumEntries).map((value: Record<string, unknown>) => Object.fromEntries(fields.flatMap<[string, string | number | null]>((field) => {
    const item = value[field]
    return typeof item === 'string' ? [[field, safeText(item)]] : typeof item === 'number' || item === null ? [[field, item]] : []
  })))
  while (JSON.stringify(selected).length > 6_000)
    selected.pop()
  return { _tag: 'Available', entries: selected, truncated: input.length > maximumEntries || selected.length < entries.length || entries.some(value => fields.some(field => typeof value[field] === 'string' && value[field].length > maximumText)) }
}

/** Only allowlisted metadata reaches a Routine. An unreadable section never becomes an empty success. */
export async function collectRoutineGitHubEvidence(input: { repository: string, read: Read, now: () => Date, readJob?: (id: number) => Promise<Result<FailedJobContext, string>>, includeSuccessfulJobs?: boolean }): Promise<RoutineGitHubEvidence> {
  const base = `/repos/${input.repository}`
  const paths = [`${base}/issues?state=open&per_page=21`, `${base}/pulls?state=open&per_page=21`, `${base}/actions/runs?per_page=21`, `${base}/deployments?per_page=21`]
  const results = await Promise.all(paths.map(path => input.read(path)))
  const select = (index: number, fields: readonly string[], key?: string): Section => {
    const result = results[index]!
    if (result._tag === 'Err')
      return { _tag: 'Unavailable', reason: safeText(result.error) }
    const value = key === undefined ? result.value : typeof result.value === 'object' && result.value !== null && key in result.value ? (result.value as Record<string, unknown>)[key] : null
    return section(value, fields, index === 0)
  }
  const deployments = select(3, ['id', 'sha', 'ref', 'environment', 'created_at'])
  const deploymentStatuses = deployments._tag === 'Unavailable'
    ? []
    : await Promise.all(deployments.entries.slice(0, 5).map(async (entry) => {
        const result = await input.read(`${base}/deployments/${entry.id}/statuses?per_page=1`)
        return { deploymentId: entry.id as number, evidence: result._tag === 'Err' ? { _tag: 'Unavailable' as const, reason: safeText(result.error) } : section(result.value, ['state', 'created_at', 'description']) }
      }))
  const workflowRuns = select(2, ['id', 'name', 'head_sha', 'status', 'conclusion', 'html_url', 'created_at'], 'workflow_runs')
  const jobLogs: JobLogSnapshot = input.readJob === undefined ? { _tag: 'NotRequested' } : await collectRoutineJobLogs(input, workflowRuns)
  return {
    observedAt: input.now().toISOString(),
    issues: select(0, ['number', 'title', 'html_url', 'updated_at']),
    pullRequests: select(1, ['number', 'title', 'html_url', 'updated_at']),
    workflowRuns,
    deployments,
    deploymentStatuses,
    jobLogs,
  }
}

async function collectRoutineJobLogs(input: { repository: string, read: Read, readJob?: (id: number) => Promise<Result<FailedJobContext, string>>, includeSuccessfulJobs?: boolean }, runs: Section): Promise<JobLogSnapshot> {
  if (runs._tag === 'Unavailable')
    return runs
  const selected = runs.entries.filter(run => typeof run.id === 'number' && (input.includeSuccessfulJobs || ['failure', 'timed_out', 'cancelled'].includes(String(run.conclusion))))
  const jobs: Array<{ runId: number, evidence: JobContextEvidence }> = []
  for (const run of selected.slice(0, 3)) {
    const listed = await input.read(`/repos/${input.repository}/actions/runs/${run.id}/jobs?per_page=4`)
    if (listed._tag === 'Err') {
      jobs.push({ runId: run.id as number, evidence: { _tag: 'Unavailable', reason: safeText(listed.error) } })
      continue
    }
    const payload = listed.value as { jobs?: unknown }
    const entries = section(payload?.jobs, ['id', 'name', 'conclusion'])
    if (entries._tag === 'Unavailable') {
      jobs.push({ runId: run.id as number, evidence: entries })
      continue
    }
    for (const entry of entries.entries.filter(job => typeof job.id === 'number').slice(0, 3 - jobs.length)) {
      const result = await input.readJob!(entry.id as number)
      jobs.push({ runId: run.id as number, evidence: result._tag === 'Err' ? { _tag: 'Unavailable', reason: safeText(result.error) } : { _tag: 'Available', job: safeJob(result.value) } })
    }
    if (jobs.length >= 3)
      break
  }
  return { _tag: 'Available', jobs, truncated: selected.length > 3 || jobs.length >= 3, logScope: 'Last 80 lines per job. This is bounded evidence, not complete log coverage.' }
}

function safeJob(job: FailedJobContext): FailedJobContext {
  const log = job.logTail.map(line => redactSecrets(line)).join('\n')
  const execution = job.execution?.slice(0, 20).map(entry => ({ run: redactSecrets(entry.run).slice(0, 1_000), shell: entry.shell === null ? null : safeText(entry.shell), workingDirectory: entry.workingDirectory === null ? null : safeText(entry.workingDirectory) }))
  return {
    runId: job.runId,
    jobName: safeText(job.jobName),
    failedStep: job.failedStep === null ? null : safeText(job.failedStep),
    logTail: log.slice(-8_000).split('\n').slice(-80),
    logTruncated: job.logTruncated === true || log.length > 8_000 || job.logTail.length > 80,
    ...(execution === undefined ? {} : { execution, executionTruncated: job.executionTruncated === true || job.execution!.length > 20 || job.execution!.some(entry => entry.run.length > 1_000) }),
    ...(job.workflow === undefined ? {} : { workflow: job.workflow._tag === 'Unavailable' ? { _tag: 'Unavailable' as const, reason: safeText(job.workflow.reason) } : job.workflow }),
  }
}

export function createRoutineGitHubEvidenceSource(options: { tokens: GitHubTokenProvider, now: () => Date, jobs: Pick<GitHubAgentSource, 'getFailedJobContext'>, createClient?: Parameters<typeof createAuthenticatedClient>[0]['createClient'] }): RoutineGitHubEvidenceSource {
  return {
    async collect(mapping, signal, includeSuccessfulJobs) {
      const repository = mapping.github
      const clients = new Map<GitHubRepositoryAccess, Promise<Result<Octokit, string>>>()
      const read: Read = async (path) => {
        const access = path.includes('/actions/') ? 'checks_read' : path.includes('/deployments') ? 'deployments_read' : 'read'
        let pending = clients.get(access)
        if (pending === undefined) {
          pending = options.tokens.getToken(repository, access, signal).then(token => token._tag === 'Err'
            ? err(token.error.message)
            : ok(createAuthenticatedClient({ tokens: options.tokens, repository, access, token: token.value.token, userAgent: 'harlan-github-agent', signal, ...(options.createClient === undefined ? {} : { createClient: options.createClient }) })))
          clients.set(access, pending)
        }
        const client = await pending
        if (client._tag === 'Err')
          return client
        return client.value.request({ method: 'GET', url: path, request: { signal } })
          .then(response => ok(response.data as unknown))
          .catch((error: unknown) => err(error instanceof Error ? error.message : String(error)))
      }
      return collectRoutineGitHubEvidence({ repository, read, now: options.now, includeSuccessfulJobs: includeSuccessfulJobs ?? false, readJob: id => options.jobs.getFailedJobContext(mapping, id, signal) })
    },
  }
}

/** Bounded ordered Run headers preserve preparation that would disappear from the failed log tail. */
export function jobExecutionContext(lines: readonly string[]): Array<{ run: string, shell: string | null, workingDirectory: string | null }> {
  const result: Array<{ run: string, shell: string | null, workingDirectory: string | null }> = []
  let current: typeof result[number] | null = null
  let scriptLines: string[] = []
  let readingScript = false
  for (const raw of lines) {
    const line = raw.replace(/^\S+Z\s+/, '')
    if (line.startsWith('##[group]Run ')) {
      current = { run: safeText(line.slice('##[group]Run '.length)), shell: null, workingDirectory: null }
      if (result.length >= 30)
        break
      result.push(current)
      scriptLines = []
      readingScript = true
    }
    else if (line.startsWith('##[endgroup]')) {
      current = null
    }
    else if (current !== null) {
      const match = line.match(/^\s*(shell|working-directory):[ \t]*(\S.*)$/)
      if (match?.[1] === 'shell') {
        current.shell = safeText(match[2]!)
        readingScript = false
        if (scriptLines.length > 0)
          current.run = redactSecrets(scriptLines.join('\n')).slice(0, 4_000)
      }
      else if (readingScript && scriptLines.join('\n').length < 4_000) {
        scriptLines.push(line.replaceAll('\x1B[36;1m', '').replaceAll('\x1B[0m', ''))
      }
      if (match?.[1] === 'working-directory')
        current.workingDirectory = safeText(match[2]!)
    }
  }
  return result
}

export async function collectRepairGitHubEvidence(input: {
  mapping: RepositoryMapping
  snapshot: GitHubChecksSnapshot
  source: Pick<GitHubAgentSource, 'getFailedJobContext'>
  signal: AbortSignal
}): Promise<RepairGitHubEvidence> {
  if (input.snapshot._tag === 'Unavailable')
    return { _tag: 'Unavailable', reason: safeText(input.snapshot.reason) }
  const failed = input.snapshot.checks.filter(check => check.source._tag === 'CheckRun' && ['failure', 'timed_out', 'cancelled'].includes(check.conclusion ?? ''))
  const jobs = await Promise.all(failed.slice(0, 5).map(async (check) => {
    const job = await input.source.getFailedJobContext(input.mapping, check.id, input.signal)
    return job._tag === 'Err'
      ? { check: safeText(check.name), evidence: { _tag: 'Unavailable' as const, reason: safeText(job.error) } }
      : { check: safeText(check.name), evidence: { _tag: 'Available' as const, job: safeJob(job.value) } }
  }))
  return { _tag: 'Available', jobs, truncated: failed.length > 5 }
}
