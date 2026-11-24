/**
 * The workflow trials the weekly `trial-report` Routine reads.
 *
 * A trial changes one workflow for a fixed time and keeps or kills the change
 * by a rule written before it started. Adding a trial is one entry here. A new
 * kind of measurement also needs one `TrialMeasure` variant and its query.
 */

/** When a trial starts counting. */
export type TrialStart
  = | { _tag: 'On', at: string }
    /** The first matching workflow event, for a trial that starts when the controller that records it deploys. */
    | { _tag: 'FirstEvent', stream: 'review_run' | 'issue_triage_status', event: string }

/** What the controller counts for one trial. */
export type TrialMeasure
  = | {
    _tag: 'CheckinWhenChanged'
    /** Sites whose `daily-checkin` runs with `when: changed`. */
    whenChangedRepositories: readonly string[]
    /** Sites whose `daily-checkin` spends an Agent turn at every scheduled instant. */
    everyRunRepositories: readonly string[]
    /** How many days before the start the comparison period covers. */
    priorDays: number
  }
  | {
    _tag: 'DiscussionRouteShadow'
    /** How many listed issues Harlan labels each week. */
    labelSample: number
    /** A real defect routed DISCUSSION at or above this confidence kills the trial. */
    killConfidence: number
    /** The share of classified issues live mode must keep out of Issue triage. */
    minimumTriageShare: number
    listLimit: number
  }
  | {
    _tag: 'PathRuleShadow'
    /** The share of reviewed heads that must qualify. */
    minimumFlaggedShare: number
    listLimit: number
  }
  | {
    _tag: 'ReadyWait'
    /** A pull request READY with passing CI for longer than this counts as overdue. */
    overdueDays: number
    /** The reading at the first run. Each weekly reading compares against it. */
    baseline: ReadyWait & { measuredAt: string }
    /** How far the overdue count must fall by the end, as a share of the baseline. */
    minimumDrop: number
    /** From this trial week on, Harlan says whether he still reads the ready digest. */
    readCheckWeek: number
  }
  | {
    _tag: 'RetroFollowThrough'
    /** Days a Candidate has to reach a merged pull request. */
    mergeDays: number
    /** The share of judged Candidates that must merge in time. */
    minimumMergedShare: number
  }
  | {
    _tag: 'ReviewReverts'
    /** Days after a merge in which a revert counts against its Review. */
    revertDays: number
    /** The largest share of judged READY merges that a revert may reach. */
    maximumReadyRevertedShare: number
  }
  | {
    _tag: 'AutoMergeHolds'
    /** The largest share of held heads that may wait only on the confidence bar or only on the label. */
    maximumHeldOnlyShare: number
  }

/** Open pull requests whose current head is READY with passing CI, at one instant. */
export interface ReadyWait {
  ready: number
  /** Those READY for longer than the trial's overdue days. */
  overdue: number
  /** Whole days since READY of the oldest overdue one, or null when none is overdue. */
  oldestDays: number | null
}

/** What an ended trial that misses its keep rule leads to. */
export type TrialMiss
  = | { _tag: 'Kill' }
    /** A measurement trial is never killed. A miss names what needs work. */
    | { _tag: 'Revise', what: string }

export type Trial
  = | {
    _tag: 'Measured'
    id: string
    title: string
    start: TrialStart
    weeks: number
    metric: string
    keepRule: string
    killRule: string
    /** What the proposal measured before the trial, in its own words. */
    before: string
    onMiss: TrialMiss
    measure: TrialMeasure
  }
  | { _tag: 'Parked', id: string, title: string, reason: string }

export const TRIALS: readonly Trial[] = [
  {
    _tag: 'Measured',
    id: 'daily-checkin-when-changed',
    title: '1. `daily-checkin` with `when: changed`',
    start: { _tag: 'On', at: '2026-11-18T00:00:00+11:00' },
    weeks: 4,
    metric: 'Issues requested and Agent runs per site per week, for each group of sites.',
    keepRule: 'Sites with `when: changed` request at least as many issues per site per week, with at least 50% fewer Agent runs per site per week.',
    killRule: 'A site with `when: changed` misses a production problem.',
    before: '140 runs, 244M input tokens, and 1 issue requested across 10 sites in the 14 days to 17 November.',
    onMiss: { _tag: 'Kill' },
    measure: {
      _tag: 'CheckinWhenChanged',
      whenChangedRepositories: ['harlan-zw/nuxtseo.com', 'harlan-zw/zhead.dev', 'harlan-zw/requestindexing.com', 'harlan-zw/unhead.unjs.io', 'harlan-zw/mdream.dev'],
      everyRunRepositories: ['harlan-zw/gscdump.com', 'harlan-zw/harlanzw.com', 'harlan-zw/skilld.dev', 'harlan-zw/unlighthouse.dev', 'harlan-zw/scripts.nuxt.com'],
      priorDays: 14,
    },
  },
  {
    _tag: 'Parked',
    id: 'action-required-once',
    title: '2. Stop repeating an unchanged Action required Task',
    reason: 'Parked. #679 already stopped the main loop, and repeats fell to about 1 in 14 days.',
  },
  {
    _tag: 'Measured',
    id: 'discussion-route-shadow',
    title: '3. Discussion route, shadow mode',
    start: { _tag: 'On', at: '2026-11-18T00:00:00+11:00' },
    weeks: 2,
    metric: 'The share of classified issues routed DISCUSSION, and precision on a labelled sample of 10 each week.',
    keepRule: 'Precision is at least 95% on the labelled sample, and live mode later keeps at least 10% of issues out of Issue triage.',
    killRule: 'A real defect is routed DISCUSSION at confidence 0.9 or above.',
    before: '172 Agent triage runs in the 30 days to 17 November, with no route.',
    onMiss: { _tag: 'Kill' },
    measure: { _tag: 'DiscussionRouteShadow', labelSample: 10, killConfidence: 0.9, minimumTriageShare: 0.1, listLimit: 25 },
  },
  {
    _tag: 'Measured',
    id: 'path-rule-shadow',
    title: '4. Path rule shadow mode for Review',
    start: { _tag: 'FirstEvent', stream: 'review_run', event: 'path_rule_shadow' },
    weeks: 2,
    metric: 'The share of reviewed heads that are prose-only, and how many of those ended Blocked.',
    keepRule: 'No flagged head ended Blocked, and at least 15% of reviewed heads qualify.',
    killRule: 'A flagged head ended Blocked for a real defect.',
    before: '872 Review runs in the 14 days to 17 November: 99 Ready and 44 Blocked.',
    onMiss: { _tag: 'Kill' },
    measure: { _tag: 'PathRuleShadow', minimumFlaggedShare: 0.15, listLimit: 20 },
  },
  {
    _tag: 'Measured',
    id: 'ready-digest',
    title: '6. Weekly `ready-digest` of pull requests ready for Harlan',
    start: { _tag: 'On', at: '2026-11-18T00:00:00+11:00' },
    weeks: 4,
    metric: 'Open pull requests whose current head has been READY with passing CI for more than 3 days, and the age of the oldest, read at each weekly run.',
    keepRule: 'By the end of week 4, that count falls by at least 50% from the first run.',
    killRule: 'Harlan stops reading the ready digest by week 2.',
    before: 'On 18 November, when the trial started, 9 of 33 READY pull requests had waited more than 3 days. The oldest had waited 50 days.',
    onMiss: { _tag: 'Kill' },
    measure: {
      _tag: 'ReadyWait',
      overdueDays: 3,
      baseline: { measuredAt: '2026-11-17T21:34:50.000Z', ready: 33, overdue: 9, oldestDays: 50 },
      minimumDrop: 0.5,
      readCheckWeek: 2,
    },
  },
  {
    _tag: 'Measured',
    id: 'retro-follow-through',
    title: '7. `agent-retro` follow-through',
    start: { _tag: 'On', at: '2026-11-18T00:00:00+11:00' },
    weeks: 6,
    metric: 'Each week\'s `agent-retro` Candidates, how many became issues, and how many merged a pull request within 14 days.',
    keepRule: 'At least half of the Candidates merge a pull request within 14 days.',
    killRule: 'None. This trial only measures, so a miss means the retro prompt needs work.',
    before: '7 Candidates from 12 October to 13 November. All 7 became issues and all 7 merged.',
    onMiss: { _tag: 'Revise', what: 'The `agent-retro` prompt' },
    measure: { _tag: 'RetroFollowThrough', mergeDays: 14, minimumMergedShare: 0.5 },
  },
  {
    _tag: 'Measured',
    id: 'review-reverts',
    title: '8. Reverts after Review',
    start: { _tag: 'On', at: '2026-11-25T00:00:00+11:00' },
    weeks: 8,
    metric: 'Merged pull requests whose merged head has a Review run, and how many a later merged pull request reverted within 30 days. Pull requests the service opened and pull requests a person opened are counted apart. Only a revert that names its pull request or merge commit counts.',
    keepRule: 'At most 5% of judged READY merges are reverted within 30 days.',
    killRule: 'None. This trial only measures, so a miss means Review needs work.',
    before: 'No revert was recorded. In the 120 days to 24 November, default branch history across the trusted checkouts shows 14 commits that undo earlier work. 4 went through a pull request, and 2 of those name the pull request they revert. Expect about one countable revert every two months, so a met keep rule says little on its own.',
    onMiss: { _tag: 'Revise', what: 'The `adversarial-review` Skill' },
    measure: { _tag: 'ReviewReverts', revertDays: 30, maximumReadyRevertedShare: 0.05 },
  },
  {
    _tag: 'Measured',
    id: 'auto-merge-holds',
    title: '9. Why Auto merge holds a READY pull request',
    start: { _tag: 'FirstEvent', stream: 'review_run', event: 'auto_merge_hold' },
    weeks: 4,
    metric: 'Each week, the candidate heads with a published READY review that Auto merge newly held, the heads for each reason, and those held only by the confidence bar or only by the label. A head counts once per reason. A head Auto merge hands to GitHub leaves no record.',
    keepRule: 'At most 25% of held heads wait only on the confidence bar or only on the label.',
    killRule: 'None. This trial only measures, so a miss means the Auto merge scope needs review.',
    before: 'No hold was recorded. Auto merge held a pull request without saying why.',
    onMiss: { _tag: 'Revise', what: 'The Auto merge scope' },
    measure: { _tag: 'AutoMergeHolds', maximumHeldOnlyShare: 0.25 },
  },
]
