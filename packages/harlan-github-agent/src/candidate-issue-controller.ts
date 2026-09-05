import type { GitHubIssuePublisher } from './github.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { Candidate, CandidateIssueCommand, ClaimedRoutineRun } from './types.ts'
import { err, ok } from './result.ts'

type CandidateIssueContext = Pick<ClaimedRoutineRun, 'repository' | 'name' | 'scheduledFor'>

/** Marks every issue a Routine files, so a reader knows what opened it. */
export function routineIssueLabel(name: ClaimedRoutineRun['name']): string {
  return `routine:${name}`
}

const routineLabelPrefix = 'routine:'

/** Whether one label names an issue a Routine filed, whatever the Routine is. */
export function hasRoutineIssueLabel(labels: readonly string[]): boolean {
  return labels.some(label => label.toLowerCase().startsWith(routineLabelPrefix))
}

/**
 * The hidden marker that matches one Candidate's issue, before and after
 * GitHub holds it. A controller that loses the reply to its own write finds
 * the issue again by this marker instead of filing the proposal twice.
 */
export function candidateFingerprintMarker(fingerprint: string): string {
  return `<!-- candidate-fingerprint: ${fingerprint} -->`
}

// GitHub refuses a title longer than 256 characters and a body longer than
// 65536. The claim repeats inside both, so it is capped once, at staging.
const maximumClaimLength = 20_000

function displayableClaim(claim: string): string {
  return claim.length <= maximumClaimLength ? claim : `${claim.slice(0, maximumClaimLength)}…`
}

// GitHub refuses a title longer than 256 characters.
const maximumTitleLength = 256

/**
 * The issue title one Candidate gets.
 *
 * The title used to be the routine name joined to the whole claim, so every
 * issue list read as truncated prose, and the name repeated the
 * `routine:<name>` label. The Agent now writes the title, and a title that
 * arrives blank falls back to the claim rather than filing an untitled issue.
 */
export function candidateIssueTitle(candidate: Pick<Candidate, 'title' | 'claim'>): string {
  const written = candidate.title.replace(/\s+/g, ' ').trim()
  const title = written.length > 0 ? written : candidate.claim.replace(/\s+/g, ' ').trim()
  return title.slice(0, maximumTitleLength)
}

/**
 * Writes the issue one Candidate proposes.
 *
 * The body carries the claim and the command that proves the fix, because the
 * triage agent that reads this issue next has none of the scan's context. The
 * fingerprint goes in a comment so a person never has to read it, and the
 * ledger can still be matched to the issue by eye when something looks wrong.
 */
export function candidateIssueBody(candidate: Candidate, routine: CandidateIssueContext): string {
  return `${candidate.claim}

**Target:** \`${candidate.target}\`

**Verify with:** \`${candidate.verification}\`

Estimated to change ${candidate.estimatedChangedFiles} ${candidate.estimatedChangedFiles === 1 ? 'file' : 'files'}.

<!-- harlan-agent-kit:routine ${routine.name} -->
${candidateFingerprintMarker(candidate.fingerprint)}

> The ${routine.name} routine opened this issue automatically on its ${routine.scheduledFor} run. It is not Harlan's own report. Close it to reject the proposal, and the reason you give stops it being offered again.`
}

/** One issue request per Candidate, ready for the controller to file. */
export function candidateIssueCommands(
  candidates: readonly Candidate[],
  routine: CandidateIssueContext,
): CandidateIssueCommand[] {
  return candidates.map((candidate) => {
    const claim = displayableClaim(candidate.claim)
    return {
      id: `${candidate.id}:issue`,
      candidateId: candidate.id,
      repository: routine.repository,
      routineName: routine.name,
      title: candidateIssueTitle(candidate),
      body: candidateIssueBody({ ...candidate, claim }, routine),
    }
  })
}

export interface CandidateIssueControllerOptions {
  github: Pick<GitHubIssuePublisher, 'createIssue' | 'findOpenIssueByFingerprint'>
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

        // GitHub may have accepted a write whose reply was lost. Finding the
        // issue by its fingerprint marker first keeps one proposal at one
        // issue, however often the pass before this one crashed mid flight.
        const existing = await options.github.findOpenIssueByFingerprint({
          repository: command.repositoryMapping,
          fingerprint: command.fingerprint,
        }, signal)
        if (existing._tag === 'Err') {
          if (!signal.aborted) {
            options.store.failCandidateIssue({
              commandId: command.id,
              workerId: command.workerId,
              fence: command.fence,
              at: options.now().toISOString(),
              reason: existing.error.message,
              status: existing.error.status,
            })
            results.push(err(`${command.repository}: ${existing.error.message}`))
          }
          return results
        }
        if (existing.value !== null) {
          options.store.completeCandidateIssue({
            commandId: command.id,
            workerId: command.workerId,
            fence: command.fence,
            at: options.now().toISOString(),
            issueNumber: existing.value.number,
            url: existing.value.url,
          })
          results.push(ok({ repository: command.repository, issueNumber: existing.value.number }))
          continue
        }

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
              status: created.error.status,
            })
            results.push(err(`${command.repository}: ${created.error.message}`))
          }
          // A refusal usually comes from GitHub itself, so the rest of the
          // pass would only spend the attempt budget on the same answer. One
          // try per command per pass backs the next one off naturally.
          return results
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
