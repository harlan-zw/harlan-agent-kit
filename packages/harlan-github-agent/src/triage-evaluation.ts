import type { ClassificationSource } from './classification.ts'
import type { PullRequestFile } from './merge-risk.ts'
import { DatabaseSync } from 'node:sqlite'
import { issueRouteQuestions } from './issue-classification.ts'
import { parseStoredIssueTriage } from './issue-triage.ts'
import { classifyPullRequestPaths, proseOnlyQuestions } from './pull-request-triage.ts'

/**
 * Replays one recorded Pull request triage decision through the current
 * decision path: the path rule first, then the classification service.
 *
 * The point is measurement, not action. Every replay compares what the path
 * would decide today against what the journal recorded, so a confidence band
 * is chosen from evidence instead of a guess.
 */
export interface TriageReplayInput {
  repository: string
  pullRequestNumber: number
  title: string
  files: PullRequestFile[]
  stored: 'ReviewRequired' | 'ReviewSkipped' | 'ReviewRequiredAfterFailure'
}

export type TriageReplay
  = | { _tag: 'RuleRequired' }
    | { _tag: 'Classified', skip: boolean, confidence: number }
    | { _tag: 'Unavailable' }

export async function replayTriage(input: TriageReplayInput, classification: ClassificationSource | null, signal?: AbortSignal): Promise<TriageReplay> {
  const verdict = classifyPullRequestPaths(input.files.map(file => file.path))
  if (verdict._tag === 'ReviewRequired')
    return { _tag: 'RuleRequired' }
  if (classification === null)
    return { _tag: 'Unavailable' }
  const result = await classification.classify({
    state: { title: input.title, changedFiles: input.files.map(file => file.path).slice(0, 300) },
    questions: proseOnlyQuestions(),
    ...(signal === undefined ? {} : { signal }),
  })
  if (result._tag === 'Err')
    return { _tag: 'Unavailable' }
  const answer = result.value.answers.review
  return {
    _tag: 'Classified',
    skip: answer.choice === 'ADVERSARIAL_REVIEW_SKIPPED',
    confidence: Math.round(answer.confidence * 100) / 100,
  }
}

export interface TriageBandSummary {
  band: number
  /** Replays the classification answered. The only sample a band choice may read. */
  classified: number
  /** Classified replays whose replayed decision equals the stored one. */
  agreed: number
  /** Replays the path rule answers. They carry no evidence about the band, because the rule can drift after a decision was stored. */
  ruleRequired: number
  /** Replays the service could not answer. They carry no evidence either way and count nowhere. */
  unavailable: number
  /** Replays that would Review what the journal skipped. Costs a Review; safe. */
  reviewsAdded: number
  /** Replays that would skip what the journal sent to Review. Costs a merge nobody read. */
  skipsAdded: number
  /** Of the replays that skip, the share the journal also skipped. */
  skipPrecision: number | null
}

/**
 * Applies one skip-confidence band to every classified replay and counts the
 * outcomes. The band gates skips, and only classified replays can skip, so
 * rule-required and unavailable replays count in their own buckets: the rule
 * can drift after a decision was stored, and an unavailable service carries
 * no evidence at all.
 */
export function summariseBand(replays: Array<{ replay: TriageReplay, stored: TriageReplayInput['stored'] }>, band: number): TriageBandSummary {
  let agreed = 0
  let ruleRequired = 0
  let unavailable = 0
  let reviewsAdded = 0
  let skipsAdded = 0
  let skipTotal = 0
  let skipAgreed = 0
  for (const { replay, stored } of replays) {
    const storedSkip = stored === 'ReviewSkipped'
    if (replay._tag === 'Unavailable') {
      unavailable += 1
      continue
    }
    if (replay._tag !== 'Classified') {
      ruleRequired += 1
      continue
    }
    const skips = replay.skip && replay.confidence >= band
    if (skips)
      skipTotal += 1
    if (skips === storedSkip) {
      agreed += 1
      if (skips)
        skipAgreed += 1
    }
    else if (storedSkip) {
      reviewsAdded += 1
    }
    else {
      skipsAdded += 1
    }
  }
  return {
    band,
    classified: agreed + reviewsAdded + skipsAdded,
    agreed,
    ruleRequired,
    unavailable,
    reviewsAdded,
    skipsAdded,
    skipPrecision: skipTotal === 0 ? null : Math.round((skipAgreed / skipTotal) * 100) / 100,
  }
}

/** Every band the summary walks, coarse enough to read and fine enough to place a floor. */
export const TRIAGE_BANDS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95] as const

/**
 * Chooses the band to ship: the one that skips the most while never skipping
 * what the journal sent to Review. When no band reaches zero, the one that
 * comes closest names the tradeoff instead of hiding it.
 */
export function suggestBand(replays: Array<{ replay: TriageReplay, stored: TriageReplayInput['stored'] }>): TriageBandSummary {
  const summaries = TRIAGE_BANDS.map(band => summariseBand(replays, band))
  const safe = summaries.filter(summary => summary.skipsAdded === 0)
  const pool = safe.length > 0 ? safe : summaries
  return pool.reduce((best, candidate) => {
    if (candidate.agreed > best.agreed)
      return candidate
    if (candidate.agreed === best.agreed && (candidate.skipPrecision ?? 0) > (best.skipPrecision ?? 0))
      return candidate
    return best
  })
}

export interface StoredTriageReplaySummary {
  replayed: number
  /** Replays the classification answered. The rule answers the rest, so they say nothing about a band. */
  classified: number
  /** Recorded decisions whose Revision has no changed-file list. They replay once a later observation records one. */
  skippedWithoutFiles: number
  suggestion: TriageBandSummary
}

/**
 * Replays the journal's recorded Pull request triage decisions, newest first,
 * through the classification service and reports the band evidence.
 *
 * The journal opens read only, so this never competes with the running
 * service for a write lock.
 */
export async function replayStoredTriage(input: {
  journalPath: string
  limit: number
  classification: ClassificationSource
  log: (line: string) => void
}): Promise<StoredTriageReplaySummary> {
  const database = new DatabaseSync(input.journalPath, { readOnly: true })
  try {
    const rows = database.prepare(`
      SELECT
        repositories.github AS repository,
        subjects.github_number AS pull_request_number,
        json_extract(revisions.payload, '$.title') AS title,
        pull_request_triage_runs.outcome_tag AS stored,
        revision_files.files_json AS files_json
      FROM pull_request_triage_runs
      JOIN subjects ON subjects.id = pull_request_triage_runs.subject_id
      JOIN repositories ON repositories.id = subjects.repository_id
      JOIN revisions ON revisions.id = pull_request_triage_runs.revision_id
      JOIN revision_files ON revision_files.subject_id = subjects.id AND revision_files.revision_id = revisions.id
      ORDER BY pull_request_triage_runs.completed_at DESC
      LIMIT ?
    `).all(input.limit) as unknown as Array<{ repository: string, pull_request_number: number, title: string | null, stored: TriageReplayInput['stored'], files_json: string }>
    const withoutFiles = database.prepare(`
      SELECT COUNT(*) AS count
      FROM pull_request_triage_runs
      WHERE NOT EXISTS (
        SELECT 1 FROM revision_files
        WHERE revision_files.subject_id = pull_request_triage_runs.subject_id
          AND revision_files.revision_id = pull_request_triage_runs.revision_id
      )
    `).get() as { count: number }

    const replays: Array<{ replay: TriageReplay, stored: TriageReplayInput['stored'] }> = []
    for (const row of rows) {
      const replay = await replayTriage({
        repository: row.repository,
        pullRequestNumber: row.pull_request_number,
        title: row.title ?? '',
        files: JSON.parse(row.files_json) as PullRequestFile[],
        stored: row.stored,
      }, input.classification)
      replays.push({ replay, stored: row.stored })
    }
    for (const band of TRIAGE_BANDS) {
      const summary = summariseBand(replays, band)
      input.log(`Band ${band}: ${summary.agreed} agreed, ${summary.reviewsAdded} extra Reviews, ${summary.skipsAdded} would skip what Review read${summary.skipPrecision === null ? '' : `, skip precision ${summary.skipPrecision}`}.`)
    }
    // Accuracy within probability bands, the check a threshold choice needs:
    // it shows where the model knows and where it guesses.
    const buckets = new Map<string, { total: number, correct: number }>()
    for (const { replay, stored } of replays) {
      if (replay._tag !== 'Classified')
        continue
      const bucket = `${Math.floor(replay.confidence * 10) / 10}-${Math.floor(replay.confidence * 10) / 10 + 0.1}`
      const entry = buckets.get(bucket) ?? { total: 0, correct: 0 }
      entry.total += 1
      if ((replay.skip && replay.confidence >= TRIAGE_BANDS[0]) === (stored === 'ReviewSkipped'))
        entry.correct += 1
      buckets.set(bucket, entry)
    }
    for (const [bucket, entry] of [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right)))
      input.log(`Confidence ${bucket}: ${entry.correct}/${entry.total} agreed with the stored decision.`)
    const suggestion = suggestBand(replays)
    if (suggestion.classified < 100)
      input.log(`Only ${suggestion.classified} of ${replays.length} replays reached the classification: below the 100-150 example floor, so treat the suggested band as provisional.`)
    return {
      replayed: replays.length,
      classified: suggestion.classified,
      skippedWithoutFiles: withoutFiles.count,
      suggestion,
    }
  }
  finally {
    database.close()
  }
}

export interface IssueTriageReplay {
  stored: 'READY_TO_IMPLEMENT' | 'READY_TO_SPEC' | 'NEEDS_INFO' | 'WAIT_TO_IMPLEMENT'
  /** The route the classification would answer, null when the call failed. */
  route: 'NEEDS_INFO' | 'WAIT_TO_IMPLEMENT' | 'AGENT_TRIAGE' | null
  confidence: number | null
}

export interface IssueBandSummary {
  band: number
  agreed: number
  /** Replays the service could not answer. They carry no evidence either way and count nowhere. */
  unavailable: number
  /** Issues the Agent sent to work that a bypass would have stalled. */
  readyStalled: number
  /** Issues the Agent wanted information for that the bypass routes the same way. */
  routedAsStored: number
}

/**
 * Applies one bypass band to the issue replays. A bypass happens only when the
 * classification names NEEDS_INFO or WAIT_TO_IMPLEMENT at or above the band
 * and the stored evidence agrees; everything else keeps the Agent turn.
 */
export function summariseIssueBand(replays: IssueTriageReplay[], band: number): IssueBandSummary {
  let agreed = 0
  let readyStalled = 0
  let routedAsStored = 0
  let unavailable = 0
  for (const replay of replays) {
    if (replay.route === null) {
      unavailable += 1
      continue
    }
    const bypass = (replay.route === 'NEEDS_INFO' || replay.route === 'WAIT_TO_IMPLEMENT')
      && replay.confidence !== null && replay.confidence >= band
    const storedBypass = replay.stored === 'NEEDS_INFO' || replay.stored === 'WAIT_TO_IMPLEMENT'
    if (bypass === storedBypass) {
      agreed += 1
      if (bypass)
        routedAsStored += 1
    }
    else if (bypass && replay.stored.startsWith('READY')) {
      readyStalled += 1
    }
    else {
      // The Agent routed for information and the bypass would not: that costs
      // one Agent turn, which is today's behaviour and never a loss.
      agreed += 1
    }
  }
  return { band, agreed, unavailable, readyStalled, routedAsStored }
}

export function suggestIssueBand(replays: IssueTriageReplay[]): IssueBandSummary {
  const summaries = TRIAGE_BANDS.map(band => summariseIssueBand(replays, band))
  const safe = summaries.filter(summary => summary.readyStalled === 0)
  const pool = safe.length > 0 ? safe : summaries
  return pool.reduce((best, candidate) => (candidate.agreed > best.agreed ? candidate : best))
}

export interface StoredIssueTriageReplaySummary {
  replayed: number
  /** Replays the classification answered. A failed call says nothing about a band. */
  answered: number
  suggestion: IssueBandSummary
}

/**
 * Replays the Agent's recorded Issue triage decisions through the route
 * questions. The journal holds the title at decision time but not the body, so
 * the replay reads the title alone and says so in its counts.
 */
export async function replayStoredIssueTriage(input: {
  journalPath: string
  limit: number
  classification: ClassificationSource
  log: (line: string) => void
}): Promise<StoredIssueTriageReplaySummary> {
  const database = new DatabaseSync(input.journalPath, { readOnly: true })
  try {
    const rows = database.prepare(`
      SELECT
        worker_tasks.evidence AS evidence,
        json_extract(revisions.payload, '$.title') AS title
      FROM worker_tasks
      JOIN subjects ON subjects.id = worker_tasks.subject_id
      JOIN repositories ON repositories.id = subjects.repository_id
      JOIN revisions ON revisions.id = worker_tasks.revision_id
      WHERE worker_tasks.kind = 'issue_triage' AND worker_tasks.state_tag = 'Completed'
        AND worker_tasks.evidence IS NOT NULL
      ORDER BY worker_tasks.updated_at DESC
      LIMIT ?
    `).all(input.limit) as unknown as Array<{ evidence: string, title: string | null }>
    const replays: IssueTriageReplay[] = []
    for (const row of rows) {
      const stored = parseStoredIssueTriage(row.evidence)
      if (stored === null)
        continue
      const result = await input.classification.classify({
        state: { title: row.title ?? '' },
        questions: issueRouteQuestions(),
      })
      if (result._tag === 'Err') {
        replays.push({ stored: stored._tag, route: null, confidence: null })
        continue
      }
      replays.push({
        stored: stored._tag,
        route: result.value.answers.route.choice,
        confidence: Math.round(result.value.answers.route.confidence * 100) / 100,
      })
    }
    for (const band of TRIAGE_BANDS) {
      const summary = summariseIssueBand(replays, band)
      input.log(`Band ${band}: ${summary.agreed}/${replays.length} agreed, ${summary.readyStalled} ready issues stalled, ${summary.routedAsStored} routed as stored, ${summary.unavailable} unavailable.`)
    }
    const suggestion = suggestIssueBand(replays)
    const answered = replays.length - suggestion.unavailable
    if (answered < 100)
      input.log(`Only ${answered} of ${replays.length} replays reached the classification: below the 100-150 example floor, so treat the suggested band as provisional.`)
    // Agreement counts every kept Agent turn, so a band that bypasses nothing
    // scores a perfect run. Say so, or the no-op reads as a result.
    if (suggestion.routedAsStored === 0)
      input.log(`Band ${suggestion.band} bypasses no Issue, so it changes nothing. Read routed as stored, never agreement.`)
    return { replayed: replays.length, answered, suggestion }
  }
  finally {
    database.close()
  }
}
