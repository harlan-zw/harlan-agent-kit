import type { GitHubIssuePublisher } from './github.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { Candidate, CandidateIssueCommand, ClaimedRoutineRun } from './types.ts'
import { err, ok } from './result.ts'

/** Marks every issue a Routine files, so a reader knows what opened it. */
export function routineIssueLabel(name: ClaimedRoutineRun['name']): string {
  return `routine:${name}`
}

/**
 * Writes the issue one Candidate proposes.
 *
 * The body carries the claim and the command that proves the fix, because the
 * triage agent that reads this issue next has none of the scan's context. The
 * fingerprint goes in a comment so a person never has to read it, and the
 * ledger can still be matched to the issue by eye when something looks wrong.
 */
export function candidateIssueBody(candidate: Candidate, routine: ClaimedRoutineRun): string {
  return `${candidate.claim}

**Target:** \`${candidate.target}\`

**Verify with:** \`${candidate.verification}\`

Estimated to change ${candidate.estimatedChangedFiles} ${candidate.estimatedChangedFiles === 1 ? 'file' : 'files'}.

<!-- harlan-agent-kit:routine ${routine.name} -->
<!-- candidate-fingerprint: ${candidate.fingerprint} -->

> The ${routine.name} routine opened this issue automatically on its ${routine.scheduledFor} run. It is not Harlan's own report. Close it to reject the proposal, and the reason you give stops it being offered again.`
}

/** One issue request per Candidate, ready for the controller to file. */
export function candidateIssueCommands(
  candidates: readonly Candidate[],
  routine: ClaimedRoutineRun,
): CandidateIssueCommand[] {
  return candidates.map(candidate => ({
    id: `${candidate.id}:issue`,
    candidateId: candidate.id,
    repository: routine.repository,
    routineName: routine.name,
    title: `${routine.name}: ${candidate.claim}`,
    body: candidateIssueBody(candidate, routine),
  }))
}

export interface CandidateIssueControllerOptions {
  github: GitHubIssuePublisher
  leaseMilliseconds?: number
  now: () => Date
  store: Pick<JournalStore, 'claimNextCandidateIssue' | 'completeCandidateIssue' | 'failCandidateIssue'>
  workerId: string
}

export interface CandidateIssueController {
  /** Files every pending Candidate issue. Answers one result per attempt. */
  publishPending: (signal: AbortSignal, limit?: number) => Promise<Array<Result<{ repository: string, issueNumber: number }, string>>>
}

/**
 * Files the issues Candidates propose, one at a time.
 *
 * A Routine that found twenty proposals would otherwise open twenty issues in
 * one burst. Draining a few per pass keeps a scan from flooding a repository
 * faster than anybody can read it, and a failure retries on the next pass
 * rather than losing the proposal.
 */
export function createCandidateIssueController(options: CandidateIssueControllerOptions): CandidateIssueController {
  const leaseMilliseconds = options.leaseMilliseconds ?? 60_000

  return {
    publishPending: async (signal, limit = 3) => {
      const results: Array<Result<{ repository: string, issueNumber: number }, string>> = []
      for (let filed = 0; filed < limit; filed += 1) {
        if (signal.aborted)
          return results
        const command = options.store.claimNextCandidateIssue(
          options.workerId,
          options.now().toISOString(),
          leaseMilliseconds,
        )
        if (command === null)
          return results

        const created = await options.github.createIssue({
          repository: command.repositoryMapping,
          title: command.title,
          body: command.body,
          labels: [routineIssueLabel(command.routineName)],
        }, signal)
        if (created._tag === 'Err') {
          // An aborted pass is a shutdown, not a refusal. Leaving the command
          // leased lets its lease expire and the next pass claim it again.
          if (!signal.aborted) {
            options.store.failCandidateIssue({
              commandId: command.id,
              workerId: command.workerId,
              fence: command.fence,
              at: options.now().toISOString(),
              reason: created.error.message,
            })
            results.push(err(`${command.repository}: ${created.error.message}`))
          }
          continue
        }

        options.store.completeCandidateIssue({
          commandId: command.id,
          workerId: command.workerId,
          fence: command.fence,
          at: options.now().toISOString(),
          issueNumber: created.value.number,
          url: created.value.url,
        })
        results.push(ok({ repository: command.repository, issueNumber: created.value.number }))
      }
      return results
    },
  }
}
