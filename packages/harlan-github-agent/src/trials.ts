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
    measure: { _tag: 'PathRuleShadow', minimumFlaggedShare: 0.15, listLimit: 20 },
  },
]
