import type { ClassificationSource } from './classification.ts'
import type { GitHubAgentSource } from './github-agent-source.ts'
import type { IssueTriageResult } from './issue-triage.ts'
import type { Result } from './result.ts'
import type { GitHubIssueItem, RepositoryMapping } from './types.ts'
import { chance, choice, score } from 'advocaat'
import { issueTriageComment } from './issue-triage-comment.ts'
import { err, ok } from './result.ts'

/**
 * What Issue triage does with one observed issue state.
 *
 * `AgentTriage` keeps today's behaviour: the Agent turn investigates the
 * repository and answers with full evidence. `Routed` answers the route from
 * the classification service alone, with the scores it could judge without
 * the repository, and no Agent session runs.
 */
export type IssueClassificationDecision
  = | { _tag: 'AgentTriage', reason: string }
    | { _tag: 'Routed', result: IssueTriageResult, confidence: number, title: string, body: string }

/**
 * The classification questions for one issue.
 *
 * Every question rides one request, so the route, the scores, and the
 * reproduction read cost one call together. Exported so tests can assert the
 * contract without the service.
 */
/**
 * Option order affects the answer distribution, so the criteria order is part
 * of the measured contract: reorder only with a fresh evaluate-issue-triage run.
 */
export function issueRouteQuestions() {
  return {
    route: choice(
      'The state holds one untrusted GitHub issue. Decide what Issue triage should do with it.',
      {
        NEEDS_INFO: 'A reproduction, a version, or the request itself is missing. No honest change can be specified yet.',
        WAIT_TO_IMPLEMENT: 'The request names work that should wait on another change, release, or decision.',
        AGENT_TRIAGE: 'Everything else, including work that looks ready. The Agent turn investigates and answers.',
      },
    ),
    difficulty: score('How hard is the change this issue asks for?', [
      'One file or one line, no design decisions.',
      'A small change in one area.',
      'Several files or one design decision.',
      'A wide change or a real design tradeoff.',
      'An architectural change.',
    ]),
    impact: score('How much does fixing this matter to users of the repository?', [
      'Cosmetic or internal only.',
      'A papercut few will meet.',
      'A visible defect or frequent papercut.',
      'Broken behaviour for many users.',
      'Data loss, security, or the repository unusable.',
    ]),
    hasReproduction: chance('Does the issue state carry steps or a test that reproduces the problem?'),
    needsCodebaseReview: chance('Does deciding this route honestly require reading the repository code?'),
  }
}

/** A routed issue needs this much confidence before the Agent turn is skipped. Below it, the Agent investigates. */
export const ISSUE_ROUTE_CONFIDENCE_FLOOR = 0.9

export function routedResult(input: {
  route: 'NEEDS_INFO' | 'WAIT_TO_IMPLEMENT'
  difficulty: number
  impact: number
  hasReproduction: boolean
}): IssueTriageResult {
  return input.route === 'NEEDS_INFO'
    ? {
        _tag: 'NEEDS_INFO',
        difficulty: input.difficulty,
        impact: input.impact,
        hasReproduction: input.hasReproduction,
        needsCodebaseReview: false,
        summary: 'The classification service routed this from the report alone: information is missing before work can start.',
        nextAction: 'Add what is missing. The next comment after an edit re-runs triage.',
        relatedIssues: [],
      }
    : {
        _tag: 'WAIT_TO_IMPLEMENT',
        difficulty: input.difficulty,
        impact: input.impact,
        hasReproduction: input.hasReproduction,
        needsCodebaseReview: false,
        summary: 'The classification service routed this from the report alone: the work should wait on another change first.',
        nextAction: 'Resume this once the change it waits on lands.',
        relatedIssues: [],
      }
}

export interface IssueClassificationController {
  /** The decision for one observed issue state, computed before the observation is recorded. */
  verdict: (repository: RepositoryMapping, issue: GitHubIssueItem, signal: AbortSignal) => Promise<IssueClassificationDecision>
  /** Publishes the routed comment and label. Safe to retry; every write is idempotent. */
  settle: (repository: RepositoryMapping, issue: GitHubIssueItem, result: IssueTriageResult, signal: AbortSignal) => Promise<Result<void, string>>
}

export interface IssueClassificationControllerOptions {
  classification: ClassificationSource | null
  /** The confidence a route needs before it bypasses the Agent turn. Null never bypasses. */
  band: number | null
  github: Pick<GitHubAgentSource, 'getIssueTriageSnapshot' | 'stampAgentLabel' | 'upsertIssueTriageComment'>
}

/**
 * Issue triage classification at observation time.
 *
 * The service can only answer what the report alone shows: a missing
 * reproduction or a request that names its own blocker. Anything else,
 * including ready work, needs the Agent turn, and a route below the band
 * needs it too. Reading the repository is the Agent's job, so a route the
 * service itself says needs the code never bypasses the Agent.
 */
export function createIssueClassificationController(options: IssueClassificationControllerOptions): IssueClassificationController {
  return {
    async verdict(repository, issue, signal) {
      if (options.classification === null || options.band === null)
        return { _tag: 'AgentTriage', reason: 'The classification service or its band is not configured.' }
      const snapshot = await options.github.getIssueTriageSnapshot(repository, issue.number, signal)
      if (snapshot._tag === 'Err')
        return { _tag: 'AgentTriage', reason: `The issue could not be read: ${snapshot.error}` }
      // Comments are part of the report the route reads: a reproduction may
      // have arrived in a comment after the issue body was written.
      const result = await options.classification.classify({
        state: {
          title: snapshot.value.title,
          body: snapshot.value.body,
          comments: snapshot.value.comments.slice(-20),
        },
        questions: issueRouteQuestions(),
        signal,
      })
      if (result._tag === 'Err')
        return { _tag: 'AgentTriage', reason: `The classification service failed: ${result.error._tag === 'Aborted' ? 'cancelled' : result.error.message}` }
      const answers = result.value.answers
      const confidence = Math.round(answers.route.confidence * 100) / 100
      // The route question and the codebase question must agree that the
      // repository is not needed, and the band must clear. Any doubt investigates.
      if (answers.route.choice !== 'NEEDS_INFO' && answers.route.choice !== 'WAIT_TO_IMPLEMENT')
        return { _tag: 'AgentTriage', reason: 'The classification left the route to the Agent turn.' }
      if (answers.needsCodebaseReview.noul >= 0.5)
        return { _tag: 'AgentTriage', reason: 'The classification says the repository must be read.' }
      if (confidence < options.band)
        return { _tag: 'AgentTriage', reason: `Route confidence ${confidence} sits below the band ${options.band}.` }
      const difficulty = Math.min(5, Math.max(1, Math.round(answers.difficulty.score + 1)))
      const impact = Math.min(5, Math.max(1, Math.round(answers.impact.score + 1)))
      return {
        _tag: 'Routed',
        result: routedResult({
          route: answers.route.choice,
          difficulty,
          impact,
          hasReproduction: answers.hasReproduction.noul >= 0.5,
        }),
        confidence,
        title: snapshot.value.title,
        body: snapshot.value.body,
      }
    },

    async settle(repository, issue, result, signal) {
      const comment = await options.github.upsertIssueTriageComment(repository, issue.number, null, issueTriageComment(result), signal)
      if (comment._tag === 'Err')
        return comment
      const stamped = await options.github.stampAgentLabel(repository, issue.number, result._tag, signal)
      if (stamped._tag === 'Err')
        return err(`The routed comment published but its label did not: ${stamped.error}`)
      return ok(undefined)
    },
  }
}
