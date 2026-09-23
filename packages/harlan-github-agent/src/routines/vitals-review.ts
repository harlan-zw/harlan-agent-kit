import type { Result } from '../result.ts'
import type { RoutineCandidate, RoutineDefinition } from './contract.ts'
import { err, ok } from '../result.ts'
import { candidateRoutine, candidateScanPrompt, canonicalFingerprint } from './candidates.ts'
import { MAXIMUM_REPORT_DETAIL_LENGTH } from './contract.ts'

/**
 * The vitals-review Routine: NuxtSEO field and lab performance data in, one
 * issue per page defect out.
 *
 * The Agent reads the CLI and maps each finding to this repository. The
 * controller owns the two decisions an Agent gets wrong under pressure: the
 * fingerprint, and whether a lab series earns an issue at all. So the Agent
 * returns the CLI rows it relied on, and this module parses them and decides.
 */

export type Strategy = 'mobile' | 'desktop'
export type FieldMetric = 'lcp' | 'inp' | 'cls'
export type LabMetric = 'lcp' | 'fcp' | 'tbt' | 'cls'
export type FieldSeverity = 'good' | 'needs-improvement' | 'poor'

const STRATEGIES: readonly Strategy[] = ['mobile', 'desktop']
const FIELD_METRICS: readonly FieldMetric[] = ['lcp', 'inp', 'cls']
const LAB_METRICS: readonly LabMetric[] = ['lcp', 'fcp', 'tbt', 'cls']
const FIELD_SEVERITIES: readonly FieldSeverity[] = ['good', 'needs-improvement', 'poor']

/** Findings seen by fewer real page views than this are noise, not work. */
export const DEFAULT_MINIMUM_VIEWS = 200

/** A lab series must stay worse, or stay Poor, for this many consecutive Scans. */
const PERSISTENT_SCANS = 2
/** A drop needs at least this many earlier Scans to compare against. */
const MINIMUM_REFERENCE_SCANS = 2
/** The reference is the median of at most this many Scans before the drop. */
const REFERENCE_WINDOW = 5

/**
 * Per-metric Threshold and Poor line.
 *
 * `poor` is Lighthouse's own Poor boundary. A delta counts only when it clears
 * both the absolute floor and the relative share of the reference, so a fast
 * page cannot trip on 50 ms of jitter and a slow one cannot hide a real step.
 */
const LAB_THRESHOLDS: Record<LabMetric, { poor: number, absolute: number, relative: number }> = {
  lcp: { poor: 4000, absolute: 500, relative: 0.2 },
  fcp: { poor: 3000, absolute: 300, relative: 0.2 },
  tbt: { poor: 600, absolute: 200, relative: 0.5 },
  cls: { poor: 0.25, absolute: 0.05, relative: 0 },
}

/** Below this, lab CLS says the shift never happens without a real user. */
const LAB_CLS_REPRODUCES = 0.1

export interface LabScan {
  path: string
  strategy: Strategy
  completedAt: string
  values: Record<LabMetric, number | null>
}

export interface VitalsFinding {
  metric: FieldMetric
  severity: FieldSeverity
  p75: number | null
  route: string
  selector: string
  estimatedViews: number
}

export type LabVerdict
  = | { _tag: 'ShortSeries', count: number }
    | { _tag: 'Steady', latest: number }
    | { _tag: 'Suspect', latest: number, reference: number }
    | { _tag: 'Unstable', latest: number, reference: number }
    | { _tag: 'Poor', latest: number, since: string, lastReferenceAt: string | null, scans: number }
    | { _tag: 'Drop', latest: number, reference: number, since: string, lastReferenceAt: string, scans: number }

export interface LabJudgement {
  path: string
  strategy: Strategy
  metric: LabMetric
  verdict: LabVerdict
}

export type LabVerification
  = | { _tag: 'Lab' }
    | { _tag: 'FieldOnly', reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function oneOf<Value extends string>(values: readonly Value[], input: unknown): Value | undefined {
  return values.find(value => value === input)
}

/** One page, one spelling: `https://a.com`, `https://a.com/` and `/` are all `/`. */
export function pagePath(urlOrPath: string): string {
  const trimmed = urlOrPath.trim()
  const path = /^https?:\/\//.test(trimmed) && URL.canParse(trimmed) ? new URL(trimmed).pathname : trimmed
  const withoutSlash = path.replace(/\/+$/, '')
  return withoutSlash === '' ? '/' : withoutSlash
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function isWorse(metric: LabMetric, value: number, reference: number): boolean {
  const threshold = LAB_THRESHOLDS[metric]
  return value - reference > Math.max(threshold.absolute, reference * threshold.relative)
}

function isPoor(metric: LabMetric, value: number): boolean {
  return value > LAB_THRESHOLDS[metric].poor
}

/**
 * Parses `nuxtseo scans list --json` rows, or `scans show` rows, into Scans.
 *
 * A failed or unfinished Scan carries no numbers, so it is left out rather
 * than read as a gap. A row that is not the CLI shape refuses the whole list,
 * because a series with a silently missing Scan can fake persistence.
 */
export function parseScanRows(input: unknown): Result<LabScan[], string> {
  if (!Array.isArray(input))
    return err('Pass the Scan rows as a list.')
  const scans: LabScan[] = []
  for (const row of input) {
    if (!isRecord(row) || typeof row.url !== 'string' || typeof row.status !== 'string')
      return err('Each Scan row needs the url, strategy, status, and completedAt that `nuxtseo scans list --json` prints.')
    const strategy = oneOf(STRATEGIES, row.strategy)
    if (strategy === undefined)
      return err(`Scan of ${row.url} names strategy ${JSON.stringify(row.strategy)}. Use mobile or desktop.`)
    if (row.status !== 'complete')
      continue
    if (typeof row.completedAt !== 'string' || Number.isNaN(Date.parse(row.completedAt)))
      return err(`Complete Scan of ${row.url} has no completedAt time.`)
    const value = (metric: LabMetric): number | null => isNumber(row[metric]) ? row[metric] : null
    scans.push({
      path: pagePath(row.url),
      strategy,
      completedAt: row.completedAt,
      values: { lcp: value('lcp'), fcp: value('fcp'), tbt: value('tbt'), cls: value('cls') },
    })
  }
  return ok(scans)
}

/**
 * Judges one metric over one page's Scans on one strategy, oldest first.
 *
 * Poor comes first: a page that sat above the Poor line for the last two Scans
 * is a defect whether or not it ever was better. Otherwise the longest run of
 * trailing Scans worse than the median of the Scans before it is the drop. The
 * drop must persist, and the Scans it is measured against must agree with each
 * other. A reference that itself swings cannot date a drop.
 */
export function judgeLabSeries(metric: LabMetric, series: readonly { completedAt: string, value: number }[]): LabVerdict {
  const values = series.map(point => point.value)
  const latest = values.at(-1)
  if (latest === undefined || values.length < PERSISTENT_SCANS)
    return { _tag: 'ShortSeries', count: values.length }

  let poorRun = 0
  while (poorRun < values.length && isPoor(metric, values[values.length - 1 - poorRun]!))
    poorRun++
  if (poorRun >= PERSISTENT_SCANS) {
    const before = series[series.length - poorRun - 1]
    return {
      _tag: 'Poor',
      latest,
      since: series[series.length - poorRun]!.completedAt,
      lastReferenceAt: before?.completedAt ?? null,
      scans: poorRun,
    }
  }

  for (let run = values.length - 1; run >= 1; run--) {
    const split = values.length - run
    const reference = values.slice(Math.max(0, split - REFERENCE_WINDOW), split)
    const middle = median(reference)
    if (!values.slice(split).every(value => isWorse(metric, value, middle)))
      continue
    if (reference.length < MINIMUM_REFERENCE_SCANS)
      return { _tag: 'ShortSeries', count: reference.length }
    if (reference.some(value => isWorse(metric, value, middle)))
      return { _tag: 'Unstable', latest, reference: middle }
    if (run < PERSISTENT_SCANS)
      return { _tag: 'Suspect', latest, reference: middle }
    return {
      _tag: 'Drop',
      latest,
      reference: middle,
      since: series[split]!.completedAt,
      lastReferenceAt: series[split - 1]!.completedAt,
      scans: run,
    }
  }
  return { _tag: 'Steady', latest }
}

/**
 * Judges every page, strategy, and metric in a Scan list.
 *
 * `scans list` interleaves desktop and mobile. Comparing across them reads a
 * schedule as a regression, so a series is always one page on one strategy.
 */
export function judgeLabScans(scans: readonly LabScan[]): LabJudgement[] {
  const series = new Map<string, LabScan[]>()
  for (const scan of scans) {
    const key = `${scan.path}\n${scan.strategy}`
    series.set(key, [...(series.get(key) ?? []), scan])
  }
  const judged: LabJudgement[] = []
  for (const group of series.values()) {
    const ordered = [...group].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
    const first = ordered[0]!
    for (const metric of LAB_METRICS) {
      const points = ordered.flatMap(scan => scan.values[metric] === null ? [] : [{ completedAt: scan.completedAt, value: scan.values[metric] }])
      if (points.length === 0)
        continue
      judged.push({ path: first.path, strategy: first.strategy, metric, verdict: judgeLabSeries(metric, points) })
    }
  }
  return judged
}

/**
 * Whether a local Unlighthouse run can prove a fix for this field metric.
 *
 * INP needs a real interaction, and lab CLS near zero means the shift only
 * happens when a person scrolls or clicks. Issue work that "verifies" either
 * in the lab would be measuring nothing.
 */
export function labVerification(metric: FieldMetric, labCls: number | null): LabVerification {
  if (metric === 'inp')
    return { _tag: 'FieldOnly', reason: 'INP needs a real interaction, so a lab run cannot reproduce it' }
  if (metric === 'cls' && (labCls === null || labCls < LAB_CLS_REPRODUCES))
    return { _tag: 'FieldOnly', reason: `lab CLS is ${labCls ?? 'unmeasured'} while field CLS is poor, so the shift happens only during real interaction` }
  return { _tag: 'Lab' }
}

export function fieldFingerprint(finding: Pick<VitalsFinding, 'route' | 'metric' | 'selector'>): string {
  const selector = finding.selector.replace(/\s+/g, ' ').trim()
  return canonicalFingerprint(`vitals-field#${pagePath(finding.route)}#${finding.metric}#${selector}`)
}

export function labFingerprint(path: string, strategy: Strategy, metric: LabMetric): string {
  return canonicalFingerprint(`vitals-lab#${pagePath(path)}#${strategy}#${metric}`)
}

interface Proposal {
  title: string
  target: string
  claim: string
  verification: string
  estimatedChangedFiles: number
}

interface FieldProposal extends Proposal {
  finding: VitalsFinding
  labCls: number | null
}

interface LabProposal extends Proposal {
  path: string
  strategy: Strategy
  metric: LabMetric
  scans: LabScan[]
  suspectCommits: string
}

function parseProposal(value: Record<string, unknown>, label: string): Result<Proposal, string> {
  if (typeof value.title !== 'string' || typeof value.target !== 'string' || value.target.trim() === ''
    || typeof value.claim !== 'string' || value.claim.trim() === '' || typeof value.verification !== 'string'
    || !isNumber(value.estimatedChangedFiles) || !Number.isInteger(value.estimatedChangedFiles) || value.estimatedChangedFiles < 1) {
    return err(`${label} needs a title, target, claim, verification, and positive file estimate.`)
  }
  return ok({ title: value.title, target: value.target, claim: value.claim, verification: value.verification, estimatedChangedFiles: value.estimatedChangedFiles })
}

/** Parses one `nuxtseo vitals findings --json` row. */
export function parseVitalsFinding(input: unknown): Result<VitalsFinding, string> {
  if (!isRecord(input))
    return err('Copy each field finding row from `nuxtseo vitals findings --json`.')
  const metric = oneOf(FIELD_METRICS, input.metric)
  const severity = oneOf(FIELD_SEVERITIES, input.severity)
  if (metric === undefined || severity === undefined
    || !(input.p75 === null || isNumber(input.p75))
    || typeof input.route !== 'string' || input.route.trim() === ''
    || typeof input.selector !== 'string'
    || !isNumber(input.estimatedViews)) {
    return err('A field finding needs the metric (lcp, inp, or cls), severity, p75, route, selector, and estimatedViews that `nuxtseo vitals findings --json` prints.')
  }
  return ok({ metric, severity, p75: input.p75 as number | null, route: input.route, selector: input.selector, estimatedViews: input.estimatedViews })
}

function parseFieldProposal(input: unknown): Result<FieldProposal, string> {
  if (!isRecord(input))
    return err('Write each field finding as an object.')
  const finding = parseVitalsFinding(input.finding)
  if (finding._tag === 'Err')
    return finding
  const proposal = parseProposal(input, `Field finding on ${finding.value.route}`)
  if (proposal._tag === 'Err')
    return proposal
  if (!(input.labCls === null || isNumber(input.labCls)))
    return err(`Field finding on ${finding.value.route} needs labCls as a number or null.`)
  return ok({ ...proposal.value, finding: finding.value, labCls: input.labCls as number | null })
}

function parseLabProposal(input: unknown): Result<LabProposal, string> {
  if (!isRecord(input) || typeof input.url !== 'string')
    return err('Write each lab finding as an object with the page url.')
  const strategy = oneOf(STRATEGIES, input.strategy)
  const metric = oneOf(LAB_METRICS, input.metric)
  if (strategy === undefined || metric === undefined)
    return err(`Lab finding on ${input.url} needs a strategy (mobile or desktop) and a metric (lcp, fcp, tbt, or cls).`)
  const proposal = parseProposal(input, `Lab finding on ${input.url}`)
  if (proposal._tag === 'Err')
    return proposal
  const scans = parseScanRows(input.scans)
  if (scans._tag === 'Err')
    return scans
  if (typeof input.suspectCommits !== 'string')
    return err(`Lab finding on ${input.url} needs suspectCommits, empty when the page was Poor from its first Scan.`)
  return ok({ ...proposal.value, path: pagePath(input.url), strategy, metric, scans: scans.value, suspectCommits: input.suspectCommits.trim() })
}

function formatValue(metric: FieldMetric | LabMetric, value: number): string {
  return metric === 'cls' ? String(Math.round(value * 1000) / 1000) : `${Math.round(value)} ms`
}

function describeVerdict(metric: LabMetric, verdict: LabVerdict): string {
  switch (verdict._tag) {
    case 'ShortSeries':
      return `ShortSeries: ${verdict.count} usable Scans`
    case 'Steady':
      return `Steady at ${formatValue(metric, verdict.latest)}`
    case 'Suspect':
      return `Suspect: one Scan at ${formatValue(metric, verdict.latest)} against ${formatValue(metric, verdict.reference)}`
    case 'Unstable':
      return `Unstable: the reference Scans disagree around ${formatValue(metric, verdict.reference)}`
    case 'Poor':
      return `Poor for the last ${verdict.scans} Scans, since ${verdict.since}, now ${formatValue(metric, verdict.latest)}${verdict.lastReferenceAt === null ? ', Poor in every retained Scan' : `, last better Scan ${verdict.lastReferenceAt}`}`
    case 'Drop':
      return `Drop from ${formatValue(metric, verdict.reference)} to ${formatValue(metric, verdict.latest)} for ${verdict.scans} Scans, since ${verdict.since}, last reference Scan ${verdict.lastReferenceAt}`
  }
}

interface Decision {
  candidates: RoutineCandidate[]
  notes: string[]
}

function decideField(proposals: readonly FieldProposal[], minimumViews: number): Decision {
  const candidates = new Map<string, RoutineCandidate>()
  const notes: string[] = []
  for (const proposal of proposals) {
    const { finding } = proposal
    const name = `Field ${finding.metric.toUpperCase()} on ${finding.route}, element \`${finding.selector}\``
    if (finding.severity !== 'poor') {
      notes.push(`- ${name}: refused, rated ${finding.severity}. Only Poor files an issue.`)
      continue
    }
    if (finding.estimatedViews < minimumViews) {
      notes.push(`- ${name}: refused, about ${finding.estimatedViews} views is under the floor of ${minimumViews}.`)
      continue
    }
    const fingerprint = fieldFingerprint(finding)
    if (candidates.has(fingerprint)) {
      notes.push(`- ${name}: merged into ${fingerprint}.`)
      continue
    }
    const verification = labVerification(finding.metric, proposal.labCls)
    const p75 = finding.p75 === null ? 'no p75' : `p75 ${formatValue(finding.metric, finding.p75)}`
    const evidence = `Field evidence: ${finding.metric.toUpperCase()} ${p75} on ${finding.route}, element \`${finding.selector}\`, about ${finding.estimatedViews} views, rated poor.`
    const lab = verification._tag === 'Lab'
      ? `Lab verification: run Unlighthouse on ${pagePath(finding.route)} before and after the fix. ${finding.metric.toUpperCase()} reproduces in the lab.`
      : `Skip lab verification: ${verification.reason}. Confirm from field data after deploy.`
    candidates.set(fingerprint, {
      fingerprint,
      title: proposal.title,
      target: proposal.target,
      claim: `${proposal.claim}\n\n${evidence}\n\n${lab}`,
      verification: proposal.verification,
      estimatedChangedFiles: proposal.estimatedChangedFiles,
    })
    notes.push(`- ${name}: filed as ${fingerprint}.`)
  }
  return { candidates: [...candidates.values()], notes }
}

function decideLab(proposals: readonly LabProposal[]): Decision {
  const candidates = new Map<string, RoutineCandidate>()
  const notes: string[] = []
  for (const proposal of proposals) {
    const name = `Lab ${proposal.strategy} ${proposal.metric.toUpperCase()} on ${proposal.path}`
    const judged = judgeLabScans(proposal.scans)
      .find(entry => entry.path === proposal.path && entry.strategy === proposal.strategy && entry.metric === proposal.metric)
    if (judged === undefined) {
      notes.push(`- ${name}: refused, the finding carries no ${proposal.strategy} Scan of this page with a ${proposal.metric.toUpperCase()} value.`)
      continue
    }
    const { verdict } = judged
    const described = describeVerdict(proposal.metric, verdict)
    if (verdict._tag !== 'Poor' && verdict._tag !== 'Drop') {
      notes.push(`- ${name}: refused, ${described}.`)
      continue
    }
    if (verdict._tag === 'Drop' && proposal.suspectCommits === '') {
      notes.push(`- ${name}: refused, a Drop must name the suspect commit range deployed between ${verdict.lastReferenceAt} and ${verdict.since}.`)
      continue
    }
    const fingerprint = labFingerprint(proposal.path, proposal.strategy, proposal.metric)
    if (candidates.has(fingerprint)) {
      notes.push(`- ${name}: merged into ${fingerprint}.`)
      continue
    }
    const suspects = proposal.suspectCommits === '' ? '' : ` Suspect commits: ${proposal.suspectCommits}.`
    candidates.set(fingerprint, {
      fingerprint,
      title: proposal.title,
      target: proposal.target,
      claim: `${proposal.claim}\n\nLab evidence: ${proposal.strategy} ${described}.${suspects}\n\nLab verification: run Unlighthouse on ${proposal.path} with --${proposal.strategy} before and after the fix.`,
      verification: proposal.verification,
      estimatedChangedFiles: proposal.estimatedChangedFiles,
    })
    notes.push(`- ${name}: filed as ${fingerprint}, ${described}.`)
  }
  return { candidates: [...candidates.values()], notes }
}

const PROPOSAL_PROPERTIES = {
  title: { type: 'string', description: 'The issue title, under 70 characters, commit subject style.' },
  target: { type: 'string', description: 'The file or component this fix changes.' },
  claim: { type: 'string', description: 'What causes the metric and how the fix removes it. The controller appends the measured evidence.' },
  verification: { type: 'string', description: 'The exact command that proves the fix before deploy.' },
  estimatedChangedFiles: { type: 'integer', minimum: 1 },
} as const

const NULLABLE_NUMBER = { type: ['number', 'null'] } as const

const SCAN_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['url', 'strategy', 'status', 'completedAt', 'lcp', 'fcp', 'tbt', 'cls'],
  description: 'One row copied from `nuxtseo scans list --json`. fcp comes from `scans show`; null when not read.',
  properties: {
    url: { type: 'string' },
    strategy: { type: 'string', enum: ['mobile', 'desktop'] },
    status: { type: 'string' },
    completedAt: { type: ['string', 'null'] },
    lcp: NULLABLE_NUMBER,
    fcp: NULLABLE_NUMBER,
    tbt: NULLABLE_NUMBER,
    cls: NULLABLE_NUMBER,
  },
} as const

const VITALS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['report', 'fieldFindings', 'labFindings'],
  properties: {
    report: { type: 'string', maxLength: MAXIMUM_REPORT_DETAIL_LENGTH, description: 'The Markdown report for this run.' },
    fieldFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding', 'labCls', ...Object.keys(PROPOSAL_PROPERTIES)],
        properties: {
          finding: {
            type: 'object',
            additionalProperties: false,
            required: ['metric', 'severity', 'p75', 'route', 'selector', 'estimatedViews', 'fixPrompt'],
            description: 'One row copied unchanged from `nuxtseo vitals findings --json`.',
            properties: {
              metric: { type: 'string', enum: FIELD_METRICS },
              severity: { type: 'string', enum: FIELD_SEVERITIES },
              p75: NULLABLE_NUMBER,
              route: { type: 'string' },
              selector: { type: 'string' },
              estimatedViews: { type: 'number' },
              fixPrompt: { type: 'string' },
            },
          },
          labCls: { ...NULLABLE_NUMBER, description: 'The latest mobile lab CLS for this route from `scans list`, or null when no Scan exists.' },
          ...PROPOSAL_PROPERTIES,
        },
      },
    },
    labFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'strategy', 'metric', 'scans', 'suspectCommits', ...Object.keys(PROPOSAL_PROPERTIES)],
        properties: {
          url: { type: 'string' },
          strategy: { type: 'string', enum: STRATEGIES },
          metric: { type: 'string', enum: LAB_METRICS },
          scans: { type: 'array', items: SCAN_ROW_SCHEMA, description: 'Every retained Scan of this page, both strategies allowed, copied from `nuxtseo scans list --json`.' },
          suspectCommits: { type: 'string', description: 'The commit range deployed between the last reference Scan and the first worse Scan. Empty only when the page was Poor in every retained Scan.' },
          ...PROPOSAL_PROPERTIES,
        },
      },
    },
  },
} as const

export interface VitalsReviewOptions {
  minimumViews: number
}

export function createVitalsReview(options: VitalsReviewOptions): RoutineDefinition {
  return {
    ...candidateRoutine,
    schema: VITALS_SCHEMA,
    scanPrompt: input => candidateScanPrompt(input, `Read the installed harlan-agent-kit:vitals-review Skill. Follow scan mode for this repository only.
Match this repository to one NuxtSEO Site through tracked configuration. Read its field findings, its field trend, and its lab Scan history with the nuxtseo CLI.
Answer with report, fieldFindings, and labFindings. Never answer with candidates: the controller derives each Candidate and its fingerprint from the rows you return, so the fingerprint rules below do not apply to you. The ledger list still shows what is already filed.
Copy CLI rows unchanged. The controller refuses a field finding that is not Poor or has fewer than ${options.minimumViews} estimated views, and a lab finding its Scans do not show as Poor or as a Drop on that strategy.
Return a Markdown report within ${MAXIMUM_REPORT_DETAIL_LENGTH} characters, even when the Site cannot be matched or a read fails.
Keep repository files and GitHub read only. The only NuxtSEO write you may make is the post-deploy \`page scan\` the Skill allows.
Do not duplicate work already owned by an open issue or pull request.`),
    parseResponse: (input) => {
      if (!isRecord(input) || typeof input.report !== 'string')
        return err('The vitals review Routine answered without its report.')
      const report = input.report.trim()
      if (report === '')
        return err('The vitals review Routine answered without its report.')
      if (report.length > MAXIMUM_REPORT_DETAIL_LENGTH)
        return err(`The vitals review report exceeds ${MAXIMUM_REPORT_DETAIL_LENGTH} characters. Shorten it and name the findings it omits.`)
      if (!Array.isArray(input.fieldFindings) || !Array.isArray(input.labFindings))
        return err('The vitals review Routine needs fieldFindings and labFindings lists, empty when nothing qualifies.')

      const fieldProposals: FieldProposal[] = []
      for (const value of input.fieldFindings) {
        const parsed = parseFieldProposal(value)
        if (parsed._tag === 'Err')
          return parsed
        fieldProposals.push(parsed.value)
      }
      const labProposals: LabProposal[] = []
      for (const value of input.labFindings) {
        const parsed = parseLabProposal(value)
        if (parsed._tag === 'Err')
          return parsed
        labProposals.push(parsed.value)
      }

      const field = decideField(fieldProposals, options.minimumViews)
      const lab = decideLab(labProposals)
      const notes = [...field.notes, ...lab.notes]
      return ok({
        report: notes.length === 0 ? report : `${report}\n\n## Controller decisions\n\n${notes.join('\n')}`,
        candidates: [...field.candidates, ...lab.candidates],
      })
    },
    issueWork: {
      ...candidateRoutine.issueWork,
      prompt: target => `Read the installed harlan-agent-kit:vitals-review Skill. Follow implementation mode within this prepared worktree for ${target}.
Re-read the cited field finding or lab Scans with the nuxtseo CLI, find what causes the metric in the current code, and fix that cause.
Verify with local Unlighthouse only when the issue says the metric reproduces in the lab. When it says to skip lab verification, say so in the pull request body and state what field data will confirm the fix.
Never state a lab number you did not measure. Do not start a NuxtSEO page scan; the Routine starts it after deploy.
Do not commit, push, publish, or change GitHub settings. The controller owns publication.`,
    },
  }
}

export const vitalsReview = createVitalsReview({ minimumViews: DEFAULT_MINIMUM_VIEWS })
