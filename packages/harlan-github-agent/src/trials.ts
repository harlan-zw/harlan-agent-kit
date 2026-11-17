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
    _tag: 'ReadyToMerge'
    /** How many days before the start the baseline covers. */
    priorDays: number
    /** How far the median wait from READY to merge must fall, as a share of the baseline. */
    minimumDrop: number
    /** From this trial week on, Harlan says whether he still reads the list. */
    readCheckWeek: number
  }
  | {
    _tag: 'RetroFollowThrough'
    /** Days a Candidate has to reach a merged pull request. */
    mergeDays: number
    /** The share of judged Candidates that must merge in time. */
    minimumMergedShare: number
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
    metric: 'The median wait from a head\'s first READY Review to its merge, against the 28 days before the trial.',
    keepRule: 'The median wait falls by at least 30%.',
    killRule: 'Harlan stops reading the Monday list by week 2.',
    before: '762 heads merged after a READY Review in the 28 days to 17 November, with a median wait of 10 minutes. 62 waited a day or more. 579 were in the 10 repositories where Auto merge covers Contained pull requests.',
    onMiss: { _tag: 'Kill' },
    measure: { _tag: 'ReadyToMerge', priorDays: 28, minimumDrop: 0.3, readCheckWeek: 2 },
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
]
