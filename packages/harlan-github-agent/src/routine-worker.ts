import type { AgentRuntimeSource } from './agent-profile.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { Candidate, ClaimedRoutineRun } from './types.ts'
import type { AgentWorkspaceManager } from './worktree.ts'
import { runAgentTurn } from './agent-turn.ts'
import { candidateIssueCommands } from './candidate-issue-controller.ts'
import { err, ok } from './result.ts'

/**
 * What a scan turn must answer with.
 *
 * A fingerprint is the identity of a proposal across runs, so the schema says
 * plainly that a line number cannot appear in one. A Candidate that renames
 * itself every morning defeats the whole ledger.
 */
export const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fingerprint', 'target', 'claim', 'verification', 'estimatedChangedFiles'],
        properties: {
          fingerprint: {
            type: 'string',
            description: 'Stable identity for this proposal. Use a file path or a symbol path. Never a line number.',
          },
          target: { type: 'string', description: 'The file or symbol this proposal changes.' },
          claim: { type: 'string', description: 'One sentence saying what is wrong.' },
          verification: { type: 'string', description: 'The exact command that proves the fix.' },
          estimatedChangedFiles: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
} as const

interface ScanResponse {
  candidates: Array<{
    fingerprint: string
    target: string
    claim: string
    verification: string
    estimatedChangedFiles: number
  }>
}

/**
 * How large a proposal may be before a Routine stops offering it.
 *
 * A Routine earns trust by proposing changes a person can read in one sitting.
 * A twenty file proposal is a refactor, and a refactor is Harlan's decision.
 */
export const DEFAULT_MAXIMUM_CHANGED_FILES = 5

/** Names the skill that answers each Routine, so the prompt never invents one. */
const ROUTINE_SKILLS = {
  'sentry-checkin': 'harlan-agent-kit:sentry-checkin',
  'pr-triage': 'harlan-agent-kit:pr-triage',
} as const

/**
 * Builds the scan prompt for one Routine run.
 *
 * Prior rejections go in verbatim. A Routine that proposes the same rejected
 * change every morning costs more trust than a wrong fix, and the ledger can
 * only refuse the write. Telling the agent why the last one was rejected is
 * what stops it spending a turn rediscovering it.
 */
export function routineScanPrompt(input: {
  mode: ClaimedRoutineRun['mode']
  name: ClaimedRoutineRun['name']
  rejected: readonly Candidate[]
  repository: string
}): string {
  const rejected = input.rejected.filter(candidate => candidate.result._tag === 'Rejected')
  const memory = rejected.length === 0
    ? 'Nothing has been rejected yet.'
    : rejected
        .map((candidate) => {
          const reason = candidate.result._tag === 'Rejected' ? candidate.result.reason : ''
          return `- ${candidate.fingerprint}: ${reason}`
        })
        .join('\n')

  return `Run the ${input.name} routine against ${input.repository}.

Apply the ${ROUTINE_SKILLS[input.name]} skill. Read it before you start.

This turn is read only. The worktree is the default branch. Do not edit, commit,
or push anything. Report what you find and stop.

Return every proposal you would make as a Candidate. Give each one a fingerprint
that stays the same next time you find it. Use a file path or a symbol path.
Never use a line number, because a line number changes when anything above it
changes.

Estimate how many files each proposal would change. Leave out anything that
would change more than ${DEFAULT_MAXIMUM_CHANGED_FILES} files.

These proposals were rejected before. Do not offer them again unless the file
has changed and the reason no longer holds:

${memory}

${input.mode === 'report'
  ? 'This routine reports only. Nothing you propose will be implemented yet.'
  : 'Each Candidate you return becomes one pull request, so keep each one small and separate.'}`
}

export interface RoutineScanWorkerOptions {
  logger: { error: (message: string) => void, info: (message: string) => void }
  maximumChangedFiles?: number
  now: () => Date
  runtime: AgentRuntimeSource
  store: Pick<JournalStore, 'listCandidates' | 'recordCandidates' | 'stageCandidateIssues'>
  workspaces: Pick<AgentWorkspaceManager, 'prepareRoutine'>
}

export interface RoutineScanWorker {
  run: (task: ClaimedRoutineRun, signal: AbortSignal) => Promise<Result<{ evidence: string }, string>>
}

/**
 * Runs one Routine scan and records what it found.
 *
 * The turn is always fresh. A scan reads a repository as it is now, so resuming
 * last week's session would answer from a tree that has moved.
 */
export function createRoutineScanWorker(options: RoutineScanWorkerOptions): RoutineScanWorker {
  const maximumChangedFiles = options.maximumChangedFiles ?? DEFAULT_MAXIMUM_CHANGED_FILES
  /**
   * A saved agent session belongs to one Item, and a Routine has none.
   *
   * Inventing an Item number to hang a session on would put a Routine in the
   * table every Item lookup reads. A scan runs without a saved session instead,
   * which is why Eject cannot reach a Routine run yet.
   */
  const sessionlessStore = {
    getWorkerSession: () => null,
    saveWorkerSession: () => undefined,
  }

  return {
    run: async (task, signal) => {
      const workspace = await options.workspaces.prepareRoutine(task, signal)
      if (workspace._tag === 'Err')
        return workspace

      const turn = await runAgentTurn(
        { now: options.now, runtime: options.runtime, store: sessionlessStore },
        {
          freshSession: true,
          // A Routine answers a clock, so it belongs to no issue or pull
          // request. Nothing reads this number, because no session is saved.
          number: 0,
          prompt: routineScanPrompt({
            mode: task.mode,
            name: task.name,
            rejected: options.store.listCandidates(task.routineId),
            repository: task.repository,
          }),
          repository: task.repository,
          role: 'routine_scan',
          schema: CANDIDATE_SCHEMA,
          taskId: task.id,
          workspace: workspace.value.path,
        },
        signal,
      )
      if (turn._tag === 'Err')
        return turn

      let response: ScanResponse
      try {
        response = JSON.parse(turn.value.response) as ScanResponse
      }
      catch {
        return err('The scan agent answered with something other than JSON.')
      }
      if (!Array.isArray(response.candidates))
        return err('The scan agent answered without a candidate list.')

      // Oversized proposals are dropped here rather than recorded and skipped
      // later, so the ledger never holds a Candidate nothing will ever open.
      const withinSize = response.candidates.filter(candidate => candidate.estimatedChangedFiles <= maximumChangedFiles)
      const dropped = response.candidates.length - withinSize.length
      const fresh = options.store.recordCandidates({
        routineId: task.routineId,
        runId: task.id,
        candidates: withinSize.map(candidate => ({
          fingerprint: candidate.fingerprint,
          target: candidate.target,
          claim: candidate.claim,
          verification: candidate.verification,
          estimatedChangedFiles: candidate.estimatedChangedFiles,
        })),
        at: options.now().toISOString(),
      })

      // A proposing Routine asks for one issue per new Candidate. The pipeline
      // that already turns an issue into a reviewed pull request does the rest,
      // so a Routine needs no publication path of its own.
      const requested = task.mode === 'propose' && fresh.length > 0
        ? options.store.stageCandidateIssues({
            commands: candidateIssueCommands(fresh, task),
            at: options.now().toISOString(),
          })
        : 0

      const evidence = [
        `${task.name} on ${task.repository}`,
        `${response.candidates.length} found`,
        `${fresh.length} new`,
        `${withinSize.length - fresh.length} already known`,
        `${dropped} over ${maximumChangedFiles} files`,
        `${requested} issues requested`,
      ].join(' | ')
      options.logger.info(evidence)
      return ok({ evidence })
    },
  }
}
