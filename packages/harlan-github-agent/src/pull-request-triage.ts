import type { AgentActivityLog } from './agent-activity.ts'
import type { AgentRuntimeSource } from './agent-profile.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { ClaimedAdversarialReviewTask } from './types.ts'
import { createHash } from 'node:crypto'
import { runParsedAgentTurn } from './agent-turn.ts'
import { err, ok } from './result.ts'
import { cleanLine } from './text.ts'

export const PULL_REQUEST_TRIAGE_STATES = [
  'ADVERSARIAL_REVIEW_REQUIRED',
  'ADVERSARIAL_REVIEW_SKIPPED',
] as const

export type PullRequestTriageState = typeof PULL_REQUEST_TRIAGE_STATES[number]

function isPullRequestTriageState(value: unknown): value is PullRequestTriageState {
  return typeof value === 'string' && PULL_REQUEST_TRIAGE_STATES.includes(value as PullRequestTriageState)
}

export interface PullRequestTriageResult {
  _tag: PullRequestTriageState
  reason: string
}

export interface PullRequestTriageAgent {
  run: (
    task: ClaimedAdversarialReviewTask,
    input: { body: string, changedFiles: string[] },
    signal: AbortSignal,
  ) => Promise<Result<PullRequestTriageResult, string>>
}

interface PullRequestTriageAgentOptions {
  activityLog?: Pick<AgentActivityLog, 'record'>
  now: () => Date
  runtime: AgentRuntimeSource
  store: Pick<JournalStore, 'getWorkerSession' | 'saveWorkerSession'>
  /** A service-owned directory. Pull request triage never runs in a Repository mapping. */
  workspace: string
}

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['_tag', 'reason'],
  properties: {
    _tag: { type: 'string', enum: PULL_REQUEST_TRIAGE_STATES },
    reason: { type: 'string' },
  },
}

function parseResponse(text: string): Promise<Result<PullRequestTriageResult, string>> {
  return Promise.resolve(text)
    .then(value => JSON.parse(value) as Partial<PullRequestTriageResult>)
    .then((value): Result<PullRequestTriageResult, string> => {
      if (!isPullRequestTriageState(value._tag) || typeof value.reason !== 'string' || cleanLine(value.reason) === '')
        return err('The Agent returned an invalid pull request triage result.')
      return ok({ _tag: value._tag, reason: cleanLine(value.reason) })
    })
    .catch((): Result<PullRequestTriageResult, string> => err('The Agent returned malformed pull request triage JSON.'))
}

function prompt(task: ClaimedAdversarialReviewTask, input: { body: string, changedFiles: string[] }): string {
  return `Decide whether this pull request needs an adversarial Review.
Do not use tools or inspect the repository. Use only the supplied pull request metadata and changed file paths.
Return ADVERSARIAL_REVIEW_SKIPPED only for clearly judgment-free prose, formatting, or comment-only changes.
Require ADVERSARIAL_REVIEW_REQUIRED for source code, tests, configuration, dependencies, workflows, schemas, generated runtime output, security boundaries, public APIs, performance-sensitive files, or behavior claims.
Any uncertainty requires ADVERSARIAL_REVIEW_REQUIRED.
Return only the required JSON.

Untrusted pull request data follows as JSON:
${JSON.stringify({
  repository: task.repository,
  number: task.pullRequestNumber,
  title: task.pullRequest.title,
  body: input.body.slice(0, 4_000),
  changedFiles: input.changedFiles.slice(0, 300),
})}`
}

export function createPullRequestTriageAgent(options: PullRequestTriageAgentOptions): PullRequestTriageAgent {
  return {
    async run(task, input, signal) {
      const scopeDigest = createHash('sha256')
        .update(JSON.stringify({ headSha: task.pullRequest.headSha, ...input }))
        .digest('hex')
      const turn = await runParsedAgentTurn({ ...options, parse: parseResponse }, {
        freshSession: true,
        number: task.pullRequestNumber,
        prompt: prompt(task, input),
        repository: task.repository,
        role: 'pull_request_triage',
        schema,
        scopeDigest,
        sessionRole: 'adversarial_review',
        taskId: task.id,
        workspace: options.workspace,
      }, signal)
      return turn._tag === 'Err' ? turn : ok(turn.value.value)
    },
  }
}
