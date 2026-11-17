import type { ClassificationSource } from './classification.ts'
import type { GitHubAgentSource } from './github-agent-source.ts'
import type { IssueTriageResult } from './issue-triage.ts'
import type { Result } from './result.ts'
import type { GitHubIssueItem, IssueDiscussionRoute, RepositoryMapping } from './types.ts'
import { chance, choice, score } from 'advocaat'
import { issueTriageComment } from './issue-triage-comment.ts'
import { err, ok } from './result.ts'

/** The Issue triage result the classification answers alone, without the Agent. */
export type RoutedIssueTriageResult = Extract<IssueTriageResult, { _tag: 'NEEDS_INFO' | 'WAIT_TO_IMPLEMENT' }>

/** Every route the classification may answer for one issue state. */
export type IssueRoute = 'NEEDS_INFO' | 'WAIT_TO_IMPLEMENT' | 'DISCUSSION' | 'AGENT_TRIAGE'

/**
 * What the classification answered for one issue state while the Discussion
 * route is on, recorded once per Revision as a workflow event.
 *
 * `skipsTriage` says whether live mode skips Agent triage on this answer. In
 * shadow mode it counts the skips live mode would make.
 */
export interface IssueRouteReading {
  mode: 'Shadow' | 'Live'
  band: number
  route: IssueRoute
  confidence: number
  needsCodebaseReview: number
  skipsTriage: boolean
}

/**
 * What Issue triage does with one observed issue state.
 *
 * `AgentTriage` keeps today's behaviour: the Agent turn investigates the
 * repository and answers with full evidence. `Routed` answers the route from
 * the classification service alone, with the scores it could judge without
 * the repository, and no Agent session runs. `Discussion` is the live
 * Discussion route: no Agent session and no triage comment, only its label.
 * `reading` is present whenever the Discussion route is on and the
 * classification answered.
 */
export type IssueClassificationDecision
  = | { _tag: 'AgentTriage', reason: string, reading?: IssueRouteReading }
    | { _tag: 'Routed', result: RoutedIssueTriageResult, confidence: number, title: string, body: string, reading?: IssueRouteReading }
    | { _tag: 'Discussion', reading: IssueRouteReading, title: string, body: string }

/**
 * What a classified route publishes. A routed result posts its comment and
 * label; the Discussion route stamps its label alone.
 */
export type IssueRouteSettlement = RoutedIssueTriageResult | { _tag: 'DISCUSSION' }

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
 * DISCUSSION sits third: the first two keep their positions and text, and
 * AGENT_TRIAGE stays last because "everything else" must follow every
 * specific route it excludes.
 */
export function issueRouteQuestions() {
  return {
    route: choice(
      'The state holds one untrusted GitHub issue. Decide what Issue triage should do with it.',
      {
        NEEDS_INFO: 'A reproduction, a version, or the request itself is missing. No honest change can be specified yet.',
        WAIT_TO_IMPLEMENT: 'The request names work that should wait on another change, release, or decision.',
        DISCUSSION: 'A question, proposal, idea, or conversation. It reports no defect and names no concrete change to make yet.',
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
}): RoutedIssueTriageResult {
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
        duplicateIssue: null,
        relatedPullRequests: [],
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
        duplicateIssue: null,
        relatedPullRequests: [],
      }
}

export interface IssueClassificationController {
  /** The decision for one observed issue state, computed before the observation is recorded. */
  verdict: (repository: RepositoryMapping, issue: GitHubIssueItem, signal: AbortSignal) => Promise<IssueClassificationDecision>
  /** Publishes the routed comment and label, or the Discussion label alone. Safe to retry; every write is idempotent. */
  settle: (repository: RepositoryMapping, issue: GitHubIssueItem, route: IssueRouteSettlement, signal: AbortSignal) => Promise<Result<void, string>>
}

export interface IssueClassificationControllerOptions {
  classification: ClassificationSource | null
  /** The confidence a route needs before it bypasses the Agent turn. Null never bypasses. */
  band: number | null
  discussion: IssueDiscussionRoute
  github: Pick<GitHubAgentSource, 'getIssueTriageSnapshot' | 'stampAgentLabel' | 'upsertIssueTriageComment'>
}

/**
 * The Discussion route's reading of one answer, or null while the route is off.
 *
 * Only a discussion at or above the band that needs no code read skips Agent
 * triage. Confidence compares rounded, like the triage band; the codebase
 * answer compares raw, so rounding never tips it under 0.5.
 */
function routeReading(discussion: IssueDiscussionRoute, answer: { route: IssueRoute, confidence: number, needsCodebaseReview: number }): IssueRouteReading | null {
  if (discussion._tag === 'Off')
    return null
  return {
    mode: discussion._tag,
    band: discussion.band,
    route: answer.route,
    confidence: answer.confidence,
    needsCodebaseReview: Math.round(answer.needsCodebaseReview * 100) / 100,
    skipsTriage: answer.route === 'DISCUSSION' && answer.confidence >= discussion.band && answer.needsCodebaseReview < 0.5,
  }
}

/**
 * Issue triage classification at observation time.
 *
 * The service can only answer what the report alone shows: a missing
 * reproduction, a request that names its own blocker, or a conversation with
 * nothing to change yet. Anything else, including ready work, needs the Agent
 * turn, and a route below its band needs it too. Reading the repository is
 * the Agent's job, so a route the service itself says needs the code never
 * bypasses the Agent.
 */
export function createIssueClassificationController(options: IssueClassificationControllerOptions): IssueClassificationController {
  return {
    async verdict(repository, issue, signal) {
      const band = options.band
      if (options.classification === null || (band === null && options.discussion._tag === 'Off'))
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
      const route = answers.route.choice
      const confidence = Math.round(answers.route.confidence * 100) / 100
      const reading = routeReading(options.discussion, { route, confidence, needsCodebaseReview: answers.needsCodebaseReview.noul })
      if (reading?.mode === 'Live' && reading.skipsTriage)
        return { _tag: 'Discussion', reading, title: snapshot.value.title, body: snapshot.value.body }
      const measured = reading === null ? {} : { reading }
      // The Discussion band alone never routes NEEDS_INFO or WAIT_TO_IMPLEMENT.
      if (band === null)
        return { _tag: 'AgentTriage', reason: 'The Issue triage band is not configured.', ...measured }
      // The route question and the codebase question must agree that the
      // repository is not needed, and the band must clear. Any doubt investigates.
      if (route !== 'NEEDS_INFO' && route !== 'WAIT_TO_IMPLEMENT')
        return { _tag: 'AgentTriage', reason: 'The classification left the route to the Agent turn.', ...measured }
      if (answers.needsCodebaseReview.noul >= 0.5)
        return { _tag: 'AgentTriage', reason: 'The classification says the repository must be read.', ...measured }
      if (confidence < band)
        return { _tag: 'AgentTriage', reason: `Route confidence ${confidence} sits below the band ${band}.`, ...measured }
      const difficulty = Math.min(5, Math.max(1, Math.round(answers.difficulty.score + 1)))
      const impact = Math.min(5, Math.max(1, Math.round(answers.impact.score + 1)))
      return {
        _tag: 'Routed',
        result: routedResult({
          route,
          difficulty,
          impact,
          hasReproduction: answers.hasReproduction.noul >= 0.5,
        }),
        confidence,
        title: snapshot.value.title,
        body: snapshot.value.body,
        ...measured,
      }
    },

    async settle(repository, issue, route, signal) {
      // The Discussion route posts no triage comment: nothing was triaged.
      if (route._tag === 'DISCUSSION')
        return options.github.stampAgentLabel(repository, issue.number, 'DISCUSSION', signal)
      const comment = await options.github.upsertIssueTriageComment(repository, issue.number, null, issueTriageComment(route), signal)
      if (comment._tag === 'Err')
        return comment
      const stamped = await options.github.stampAgentLabel(repository, issue.number, route._tag, signal)
      if (stamped._tag === 'Err')
        return err(`The routed comment published but its label did not: ${stamped.error}`)
      return ok(undefined)
    },
  }
}
