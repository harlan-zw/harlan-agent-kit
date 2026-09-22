import type { AgentActivityLog } from './agent-activity.ts'
import type { AgentRuntimeSource } from './agent-profile.ts'
import type { AgentPhase } from './agent-progress.ts'
import type { AgentTokenUsage } from './agent-provider.ts'
import type { ClassificationSource } from './classification.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { ClaimedRoutineRun } from './types.ts'
import type { AgentWorkspaceManager } from './worktree.ts'
import { agentPhase } from './agent-progress.ts'
import { runAgentTurn } from './agent-turn.ts'
import { candidateIssueCommands } from './candidate-issue-controller.ts'
import { err, ok } from './result.ts'
import { routineReportCommand } from './routine-report-controller.ts'
import { worthFiling } from './routines/candidates.ts'
import { getRoutine } from './routines/index.ts'

export interface RoutineScanWorkerOptions {
  activityLog?: Pick<AgentActivityLog, 'record'>
  /** When present, each proposed Candidate must earn its issue: the classification drops only a confident no. */
  classification?: ClassificationSource | null
  logger: { error: (message: string) => void, info: (message: string) => void }
  maximumChangedFiles?: number
  now: () => Date
  runtime: AgentRuntimeSource
  store: Pick<JournalStore, 'listAgentFeedback' | 'listCandidates' | 'recordCandidates' | 'stageCandidateIssues' | 'stageRoutineReport' | 'updateRoutineRunProgress'>
  workspaces: Pick<AgentWorkspaceManager, 'prepareRoutine'>
}

export interface RoutineScanWorker {
  run: (task: ClaimedRoutineRun, signal: AbortSignal) => Promise<Result<{ evidence: string, usage: AgentTokenUsage }, string>>
}

/**
 * Runs one Routine scan and records what it found.
 *
 * The turn is always fresh. A scan reads a repository as it is now, so resuming
 * last week's session would answer from a tree that has moved.
 */
export function createRoutineScanWorker(options: RoutineScanWorkerOptions): RoutineScanWorker {
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
      const definition = getRoutine(task.name)
      const maximumChangedFiles = definition.maximumChangedFiles === null
        ? null
        : options.maximumChangedFiles ?? definition.maximumChangedFiles
      const preparation = definition.prepare(task.repository, { listAgentFeedback: limit => options.store.listAgentFeedback(limit) })
      if (preparation._tag === 'Err')
        return preparation
      if (preparation.value._tag === 'Skip') {
        const { evidence, progressLabel } = preparation.value
        options.store.updateRoutineRunProgress({
          taskId: task.id,
          workerId: task.state.workerId,
          fence: task.state.fence,
          progress: agentPhase('Reporting', progressLabel),
          at: options.now().toISOString(),
        })
        options.store.stageRoutineReport({
          command: routineReportCommand({
            repository: task.repository,
            routineId: task.routineId,
            routineName: task.name,
            run: { id: task.id, scheduledFor: task.scheduledFor },
            report: { _tag: 'Completed', evidence },
          }),
          at: options.now().toISOString(),
        })
        options.logger.info(evidence)
        return ok({ evidence, usage: { _tag: 'Unavailable' } })
      }
      const workspace = await options.workspaces.prepareRoutine(task, signal)
      if (workspace._tag === 'Err')
        return workspace

      const reportProgress = (phase: AgentPhase): Result<void, string> => options.store.updateRoutineRunProgress({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        progress: phase,
        at: options.now().toISOString(),
      })
        ? ok(undefined)
        : err('The Routine lease ended before progress could be saved.')
      const ready = reportProgress(agentPhase('WorktreeReady', 'Git worktree ready'))
      if (ready._tag === 'Err')
        return ready

      const turn = await runAgentTurn(
        {
          ...(options.activityLog === undefined ? {} : { activityLog: options.activityLog }),
          now: options.now,
          runtime: options.runtime,
          store: sessionlessStore,
        },
        {
          freshSession: true,
          // A Routine answers a clock, so it belongs to no issue or pull
          // request. Nothing reads this number, because no session is saved.
          number: 0,
          prompt: `${definition.scanPrompt({
            mode: task.mode,
            name: task.name,
            priorCandidates: options.store.listCandidates(task.routineId),
            repository: task.repository,
            feedback: preparation.value.feedback,
          })}\n\nRoutine run ID: ${JSON.stringify(task.id)}\nScheduled for: ${task.scheduledFor}`,
          repository: task.repository,
          role: 'routine_scan',
          schema: definition.schema,
          taskId: task.id,
          workspace: workspace.value.path,
          progress: { current: agentPhase('WorktreeReady', 'Git worktree ready'), report: reportProgress, work: 'routine' },
        },
        signal,
      )
      if (turn._tag === 'Err')
        return turn

      let answer: unknown
      try {
        answer = JSON.parse(turn.value.response)
      }
      catch {
        return err('The scan agent answered with something other than JSON.')
      }
      const parsed = definition.parseResponse(answer)
      if (parsed._tag === 'Err')
        return parsed
      const response = parsed.value
      const detail = response.report

      // Oversized proposals are dropped here rather than recorded and skipped
      // later, so the ledger never holds a Candidate nothing will ever open.
      const inScope = definition.selectCandidates(response.candidates)
      const withinSize = maximumChangedFiles === null
        ? inScope
        : inScope.filter(candidate => candidate.estimatedChangedFiles <= maximumChangedFiles)
      const outsideScope = response.candidates.length - inScope.length
      const oversized = inScope.length - withinSize.length
      // The ledger decides before the gate does: a fingerprint it already
      // holds can only re-record as a no-op, so a worth call on it buys
      // nothing and its drop would mislabel prior knowledge as this run's
      // judgement. It stays in the recording set, where the ledger's own
      // conflict rule turns it into the no-op it is.
      const knownFingerprints = new Set(options.store.listCandidates(task.routineId).map(entry => entry.fingerprint))
      const unclassified = withinSize.filter(candidate => !knownFingerprints.has(candidate.fingerprint))
      // The worth gate files on every doubt, so a dropped Candidate is the
      // classification saying no with confidence. Nothing else drops here.
      const worthRecording = options.classification === undefined || options.classification === null
        ? withinSize
        : withinSize.filter(candidate => knownFingerprints.has(candidate.fingerprint))
      for (const candidate of unclassified) {
        if (options.classification === undefined || options.classification === null)
          break
        const worth = await worthFiling({
          classification: options.classification,
          routineName: task.routineId,
          candidate,
          signal,
        })
        if (worth)
          worthRecording.push(candidate)
        else
          options.logger.info(`${task.routineId}: the classification dropped Candidate ${candidate.fingerprint}.`)
      }
      const fresh = options.store.recordCandidates({
        routineId: task.routineId,
        runId: task.id,
        candidates: worthRecording,
        at: options.now().toISOString(),
      })

      // A proposing Routine asks for one issue per new Candidate. The pipeline
      // that already turns an issue into a reviewed pull request does the rest,
      // so a Routine needs no publication path of its own.
      // A process may stop after the Candidate write and before the Publication
      // command. Restage every Candidate owned by this Run. The command ledger
      // removes duplicates and closes that crash gap on retry.
      const runCandidates = options.store.listCandidates(task.routineId)
        .filter(candidate => candidate.runId === task.id)
      const requested = task.mode === 'propose' && runCandidates.length > 0
        ? options.store.stageCandidateIssues({
            commands: candidateIssueCommands(runCandidates, task),
            at: options.now().toISOString(),
          })
        : 0

      // A gate drop is a judgement this run made, not prior knowledge: the run
      // line names it as its own count so the ledger and the report agree.
      const droppedByGate = withinSize.length - worthRecording.length
      const evidence = [
        `${task.name} on ${task.repository}`,
        `${response.candidates.length} ${definition.findingsLabel}`,
        `${fresh.length} new`,
        `${withinSize.length - fresh.length - droppedByGate} already known`,
        `${outsideScope} outside allowed scope`,
        maximumChangedFiles === null ? 'no file limit' : `${oversized} over ${maximumChangedFiles} files`,
        ...(droppedByGate === 0 ? [] : [`${droppedByGate} dropped by the classification gate`]),
        `${requested} issues requested`,
      ].join(' | ')
      // Every run writes its line, including the ones that found nothing. A
      // quiet morning and a stopped scheduler must not read the same.
      options.store.stageRoutineReport({
        command: routineReportCommand({
          repository: task.repository,
          routineId: task.routineId,
          routineName: task.name,
          run: { id: task.id, scheduledFor: task.scheduledFor },
          report: {
            _tag: 'Completed',
            evidence,
            ...(detail === '' ? {} : { detail }),
            ...(response.verdict === undefined ? {} : { verdict: response.verdict }),
          },
        }),
        at: options.now().toISOString(),
      })
      options.logger.info(evidence)
      return ok({ evidence, usage: turn.value.usage })
    },
  }
}
