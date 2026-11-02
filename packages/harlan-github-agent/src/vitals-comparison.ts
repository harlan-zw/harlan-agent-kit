import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export interface VitalsComparisonTarget {
  path: string
  strategy: 'mobile' | 'desktop'
  metric: 'lcp' | 'fcp' | 'tbt' | 'cls'
}

export interface VitalsComparisonRequest {
  id: string
  taskId: string
  revisionId: string
  baseSha: string
  issuedAt: string
  targets: readonly VitalsComparisonTarget[]
}

type Metrics = Record<VitalsComparisonTarget['metric'], number>
interface HashEvidence { sha256: string, bytes: number }
interface ReportEvidence extends HashEvidence { fetchTime: string, durationMs: number, metrics: Metrics, transferBytes: number }
interface ResourceEvidence extends HashEvidence { url: string, statusCode: number }
interface SideSummary {
  median: Metrics
  range: Metrics
  transferBytes: { median: number, range: number }
  reports: ReportEvidence[]
  document: HashEvidence
  dataResources: ResourceEvidence[]
}
export interface VitalsComparisonSummary {
  target: VitalsComparisonTarget
  before: SideSummary
  after: SideSummary
  runner: { lighthouseVersion: string, hostUserAgent: string, networkUserAgent: string, settingsSha256: string, url: string }
  improvement: { absolute: number, percent: number, requiredAbsolute: number, requiredPercent: number }
}

export type VitalsComparisonResult
  = { _tag: 'Accepted', requestId: string, reason: string, comparisons: VitalsComparisonSummary[] }
    | { _tag: 'RejectedCandidate', requestId: string, reason: string, comparisons: VitalsComparisonSummary[] }
    | { _tag: 'FixtureReviewRequired', requestId: string, reason: string, comparisons: VitalsComparisonSummary[] }
    | { _tag: 'Unavailable', requestId: string, reason: string }

interface ManifestSide { url: string, dataResources: { url: string }[] }
interface ManifestTarget extends VitalsComparisonTarget { before: ManifestSide, after: ManifestSide }
interface Manifest { targets: ManifestTarget[] }
interface MeasuredReport extends ReportEvidence {
  settings: string
  lighthouseVersion: string
  hostUserAgent: string
  networkUserAgent: string
  dataRequests: { url: string, resourceBytes: number, statusCode: number }[]
}

const limits = { manifest: 1024 * 1024, report: 2 * 1024 * 1024, document: 4 * 1024 * 1024, data: 4 * 1024 * 1024, total: 128 * 1024 * 1024 }
const metricNames = ['lcp', 'fcp', 'tbt', 'cls'] as const
const auditNames = { lcp: 'largest-contentful-paint', fcp: 'first-contentful-paint', tbt: 'total-blocking-time', cls: 'cumulative-layout-shift' } as const
const thresholds: Record<VitalsComparisonTarget['metric'], { absolute: number, percent: number }> = { lcp: { absolute: 500, percent: 20 }, fcp: { absolute: 300, percent: 20 }, tbt: { absolute: 200, percent: 50 }, cls: { absolute: 0.05, percent: 0 } }

function fail(reason: string): never {
  throw Object.assign(new Error(reason), { _tag: 'InvalidVitalsEvidence' as const })
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, maximum = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0')
}

function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function timestamp(value: unknown): value is string {
  return text(value, 40) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function hash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function parseTarget(value: unknown): VitalsComparisonTarget {
  if (!record(value) || !text(value.path, 2048) || !value.path.startsWith('/') || value.path.startsWith('//') || /[?#\\]/.test(value.path) || new URL(value.path, 'http://localhost').pathname !== value.path || !['mobile', 'desktop'].includes(String(value.strategy)) || !metricNames.includes(value.metric as VitalsComparisonTarget['metric']))
    fail('The vitals comparison target is invalid.')
  return { path: value.path, strategy: value.strategy as VitalsComparisonTarget['strategy'], metric: value.metric as VitalsComparisonTarget['metric'] }
}

export function parseVitalsComparisonRequest(value: unknown): VitalsComparisonRequest {
  if (!record(value) || !text(value.id, 36) || !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value.id) || !text(value.taskId, 128) || !/^[\da-z][\w-]*$/i.test(value.taskId) || !text(value.revisionId, 64) || !/^[\da-f]{64}$/i.test(value.revisionId) || !text(value.baseSha, 40) || !/^[\da-f]{40}$/i.test(value.baseSha) || !timestamp(value.issuedAt) || !Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > 8)
    fail('The vitals comparison request is invalid.')
  const targets = value.targets.map(parseTarget)
  if (new Set(targets.map(target => JSON.stringify(target))).size !== targets.length)
    fail('The vitals comparison targets must be distinct.')
  return { id: value.id, taskId: value.taskId, revisionId: value.revisionId, baseSha: value.baseSha, issuedAt: value.issuedAt, targets }
}

export function vitalsEvidenceDirectory(request: VitalsComparisonRequest, home: string): string {
  const parsed = parseVitalsComparisonRequest(request)
  if (!text(home) || !home.startsWith('/') || resolve(home) !== home)
    fail('The vitals evidence home must be an absolute path.')
  return join(home, 'scratch', 'vitals-review', parsed.taskId, parsed.id)
}

function parseUrl(value: unknown): string {
  if (!text(value, 8192) || !URL.canParse(value))
    fail('A vitals evidence URL is invalid.')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    fail('A vitals evidence URL is invalid.')
  return url.href
}

function parseManifest(value: unknown, request: VitalsComparisonRequest): Manifest {
  if (!record(value) || value.schemaVersion !== 1 || value.requestId !== request.id || value.taskId !== request.taskId || value.revisionId !== request.revisionId || value.baseSha !== request.baseSha || value.issuedAt !== request.issuedAt || !Array.isArray(value.targets) || value.targets.length !== request.targets.length)
    fail('The vitals manifest does not match its request.')
  return { targets: value.targets.map((entry, index) => {
    const target = parseTarget(entry)
    if (JSON.stringify(target) !== JSON.stringify(request.targets[index]) || !record(entry))
      fail('The vitals manifest target does not match its request.')
    const sides = (['before', 'after'] as const).map((side) => {
      const candidate = entry[side]
      if (!record(candidate) || !Array.isArray(candidate.dataResources) || candidate.dataResources.length > 64)
        fail('The vitals data resource list is invalid.')
      const url = parseUrl(candidate.url)
      if (new URL(url).pathname !== target.path || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
        fail('The vitals evidence URL does not match its target.')
      const dataResources = candidate.dataResources.map((resource) => {
        if (!record(resource))
          fail('The vitals data resource list is invalid.')
        return { url: parseUrl(resource.url) }
      })
      if (new Set(dataResources.map(resource => resource.url)).size !== dataResources.length)
        fail('The vitals data resource URLs must be distinct.')
      return { url, dataResources }
    })
    if (sides[0]!.url !== sides[1]!.url)
      fail('Both comparison sides must use the same page URL.')
    return { ...target, before: sides[0]!, after: sides[1]! }
  }) }
}

function boundedJson(buffer: Buffer): unknown {
  let value: unknown
  try {
    value = JSON.parse(buffer.toString('utf8'))
  }
  catch (error) {
    if (!(error instanceof SyntaxError))
      throw error
    fail('The vitals evidence JSON is malformed.')
  }
  const budget = { remaining: 250_000 }
  const inspect = (entry: unknown, depth: number): void => {
    if (--budget.remaining < 0 || depth > 64)
      fail('The vitals evidence JSON exceeds its structure limit.')
    if (typeof entry === 'number' && !Number.isFinite(entry))
      fail('The vitals evidence JSON contains an invalid number.')
    if (Array.isArray(entry))
      entry.forEach(child => inspect(child, depth + 1))
    else if (record(entry))
      Object.values(entry).forEach(child => inspect(child, depth + 1))
  }
  inspect(value, 0)
  return value
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => record(entry) ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))) : entry)
}

function privateMetadata(metadata: Stats, directory: boolean): void {
  if ((directory ? !metadata.isDirectory() : !metadata.isFile()) || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0 || (!directory && metadata.nlink !== 1))
    fail('Vitals evidence must use private directories and regular private files.')
}

async function openRoot(directory: string): Promise<FileHandle> {
  if (!text(directory) || !directory.startsWith('/') || resolve(directory) !== directory)
    fail('The vitals evidence directory must be an absolute path.')
  let current = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    for (const part of directory.split('/').filter(Boolean)) {
      const next = await open(`/proc/self/fd/${current.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      await current.close()
      current = next
    }
    privateMetadata(await current.stat(), true)
    return current
  }
  catch (error) {
    await current.close()
    throw error
  }
}

async function openChild(parent: FileHandle, name: string): Promise<FileHandle> {
  const child = await open(`/proc/self/fd/${parent.fd}/${name}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    privateMetadata(await child.stat(), true)
    return child
  }
  catch (error) {
    await child.close()
    throw error
  }
}

async function readBounded(directory: FileHandle, name: string, maximum: number, budget: { remaining: number }): Promise<Buffer> {
  const file = await open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    privateMetadata(before, false)
    if (before.size > maximum || before.size > budget.remaining)
      fail('The vitals evidence exceeds its byte limit.')
    const buffer = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < buffer.byteLength) {
      const { bytesRead } = await file.read(buffer, offset, buffer.byteLength - offset, offset)
      if (bytesRead === 0)
        break
      offset += bytesRead
    }
    const after = await file.stat()
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      fail('The vitals evidence changed while it was read.')
    budget.remaining -= offset
    return buffer.subarray(0, offset)
  }
  finally {
    await file.close()
  }
}

function parseReport(buffer: Buffer, request: VitalsComparisonRequest, target: VitalsComparisonTarget, url: string): MeasuredReport {
  const value = boundedJson(buffer)
  if (!record(value) || !text(value.lighthouseVersion, 100) || !/^\d+\.\d+\.\d+/.test(value.lighthouseVersion) || value.requestedUrl !== url || value.finalDisplayedUrl !== url || (value.runtimeError !== undefined && value.runtimeError !== null) || !Array.isArray(value.runWarnings) || value.runWarnings.length !== 0 || !timestamp(value.fetchTime) || !record(value.timing) || !number(value.timing.total) || value.timing.total <= 0 || value.timing.total > 3_600_000)
    fail('A Lighthouse report is incomplete or failed.')
  if (Date.parse(value.fetchTime) < Date.parse(request.issuedAt) - 2000 || Date.parse(value.fetchTime) + value.timing.total > Date.now() + 2000)
    fail('A Lighthouse report falls outside the current request time.')
  if (!record(value.configSettings) || value.configSettings.formFactor !== target.strategy || value.configSettings.throttlingMethod !== 'simulate' || value.configSettings.disableStorageReset !== false || !record(value.configSettings.screenEmulation) || value.configSettings.screenEmulation.mobile !== (target.strategy === 'mobile') || value.configSettings.screenEmulation.disabled !== false || !record(value.environment) || !text(value.environment.hostUserAgent, 2048) || !text(value.environment.networkUserAgent, 2048) || !record(value.audits))
    fail('A Lighthouse report lacks the required cold-run settings.')
  const audits = value.audits
  const transfer = audits['total-byte-weight']
  if (!record(transfer) || !number(transfer.numericValue))
    fail('A Lighthouse report lacks its measured transfer cost.')
  const metrics = Object.fromEntries(metricNames.map((metric) => {
    const audit = audits[auditNames[metric]]
    if (!record(audit) || !number(audit.numericValue))
      fail('A Lighthouse report lacks a measured performance metric.')
    return [metric, audit.numericValue]
  })) as Metrics
  const network = audits['network-requests']
  if (!record(network) || !record(network.details) || !Array.isArray(network.details.items) || network.details.items.length > 2000)
    fail('A Lighthouse report lacks bounded request evidence.')
  const dataRequests: { url: string, resourceBytes: number, statusCode: number }[] = []
  let successfulDocument = false
  for (const item of network.details.items) {
    if (!record(item) || !text(item.url, 8192))
      fail('A Lighthouse request row is invalid.')
    const data = item.resourceType === 'Fetch' || item.resourceType === 'XHR' || (item.resourceType !== 'Script' && typeof item.mimeType === 'string' && /(?:\/|\+)json(?:;|$)/i.test(item.mimeType))
    if (item.resourceType === 'Document' && item.url === url && number(item.statusCode) && item.statusCode >= 200 && item.statusCode < 300)
      successfulDocument = true
    if (data) {
      if (!number(item.resourceSize) || !number(item.statusCode) || !Number.isInteger(item.statusCode) || item.statusCode < 100 || item.statusCode > 599)
        fail('A Lighthouse data request lacks its response size or status.')
      dataRequests.push({ url: parseUrl(item.url), resourceBytes: item.resourceSize, statusCode: item.statusCode })
    }
  }
  if (!successfulDocument)
    fail('The measured page document did not return a successful response.')
  return { sha256: hash(buffer), bytes: buffer.byteLength, fetchTime: value.fetchTime, durationMs: value.timing.total, metrics, transferBytes: transfer.numericValue, settings: canonical(value.configSettings), lighthouseVersion: value.lighthouseVersion, hostUserAgent: value.environment.hostUserAgent, networkUserAgent: value.environment.networkUserAgent, dataRequests }
}

function metrics(values: unknown): Metrics {
  if (!record(values) || !metricNames.every(metric => number(values[metric])))
    fail('A vitals comparison metric summary is invalid.')
  return Object.fromEntries(metricNames.map(metric => [metric, values[metric]])) as Metrics
}

function hashEvidence(value: unknown): HashEvidence {
  if (!record(value) || !text(value.sha256, 64) || !/^[\da-f]{64}$/i.test(value.sha256) || !number(value.bytes) || value.bytes > limits.total)
    fail('Vitals comparison provenance is invalid.')
  return { sha256: value.sha256, bytes: value.bytes }
}

function statistics(reports: readonly ReportEvidence[]): Pick<SideSummary, 'median' | 'range' | 'transferBytes'> {
  const summarizeMetric = (operation: (values: number[]) => number): Metrics => Object.fromEntries(metricNames.map(metric => [metric, operation(reports.map(report => report.metrics[metric]))])) as Metrics
  const transfers = reports.map(report => report.transferBytes)
  return { median: summarizeMetric(values => values.toSorted((left, right) => left - right)[1]!), range: summarizeMetric(values => Math.max(...values) - Math.min(...values)), transferBytes: { median: transfers.toSorted((left, right) => left - right)[1]!, range: Math.max(...transfers) - Math.min(...transfers) } }
}

function improvement(target: VitalsComparisonTarget, before: SideSummary, after: SideSummary): VitalsComparisonSummary['improvement'] {
  const absolute = before.median[target.metric] - after.median[target.metric]
  return { absolute, percent: before.median[target.metric] === 0 ? 0 : 100 * absolute / before.median[target.metric], requiredAbsolute: thresholds[target.metric].absolute, requiredPercent: thresholds[target.metric].percent }
}

function parseSummary(value: unknown): VitalsComparisonSummary {
  if (!record(value) || !record(value.runner) || !text(value.runner.lighthouseVersion, 100) || !text(value.runner.hostUserAgent, 2048) || !text(value.runner.networkUserAgent, 2048) || !text(value.runner.settingsSha256, 64) || !/^[\da-f]{64}$/i.test(value.runner.settingsSha256) || !record(value.improvement) || !['absolute', 'percent', 'requiredAbsolute', 'requiredPercent'].every(key => typeof value.improvement === 'object' && value.improvement !== null && typeof (value.improvement as Record<string, unknown>)[key] === 'number' && Number.isFinite((value.improvement as Record<string, unknown>)[key])))
    fail('The vitals comparison summary is invalid.')
  const parseSide = (side: unknown): SideSummary => {
    if (!record(side) || !Array.isArray(side.reports) || side.reports.length !== 3 || !Array.isArray(side.dataResources) || side.dataResources.length > 64 || !record(side.transferBytes) || !number(side.transferBytes.median) || !number(side.transferBytes.range))
      fail('The vitals comparison side is invalid.')
    const reports = side.reports.map((report) => {
      if (!record(report) || !timestamp(report.fetchTime) || !number(report.durationMs) || report.durationMs <= 0 || !number(report.transferBytes))
        fail('The vitals report provenance is invalid.')
      return { ...hashEvidence(report), fetchTime: report.fetchTime, durationMs: report.durationMs, metrics: metrics(report.metrics), transferBytes: report.transferBytes }
    })
    const computed = statistics(reports)
    if (canonical(metrics(side.median)) !== canonical(computed.median) || canonical(metrics(side.range)) !== canonical(computed.range) || side.transferBytes.median !== computed.transferBytes.median || side.transferBytes.range !== computed.transferBytes.range)
      fail('The vitals summary does not match its measured samples.')
    return { ...computed, reports, document: hashEvidence(side.document), dataResources: side.dataResources.map((resource) => {
      if (!record(resource) || !number(resource.statusCode) || !Number.isInteger(resource.statusCode) || resource.statusCode < 100 || resource.statusCode > 599)
        fail('A vitals data resource status is invalid.')
      return { ...hashEvidence(resource), url: parseUrl(resource.url), statusCode: resource.statusCode }
    }) }
  }
  const target = parseTarget(value.target)
  const before = parseSide(value.before)
  const after = parseSide(value.after)
  const computed = improvement(target, before, after)
  if (Object.entries(computed).some(([key, entry]) => (value.improvement as Record<string, unknown>)[key] !== entry))
    fail('The vitals improvement does not match its measured samples.')
  return { target, before, after, runner: { lighthouseVersion: value.runner.lighthouseVersion, hostUserAgent: value.runner.hostUserAgent, networkUserAgent: value.runner.networkUserAgent, settingsSha256: value.runner.settingsSha256, url: parseUrl(value.runner.url) }, improvement: computed }
}

export function parseVitalsComparisonResult(value: unknown): VitalsComparisonResult {
  if (!record(value) || !text(value.requestId, 128) || !text(value.reason, 2048))
    fail('The vitals comparison result is invalid.')
  if (value._tag === 'Unavailable')
    return { _tag: value._tag, requestId: value.requestId, reason: value.reason }
  if (!['Accepted', 'RejectedCandidate', 'FixtureReviewRequired'].includes(String(value._tag)) || !Array.isArray(value.comparisons) || value.comparisons.length < 1 || value.comparisons.length > 8)
    fail('The vitals comparison result is invalid.')
  const comparisons = value.comparisons.map(parseSummary)
  const rejected = comparisons.some(rejectedComparison)
  const changedFixtures = comparisons.some(changedData)
  if ((value._tag === 'Accepted' && (rejected || changedFixtures)) || (value._tag === 'RejectedCandidate' && !rejected) || (value._tag === 'FixtureReviewRequired' && (rejected || !changedFixtures)))
    fail('The vitals outcome does not match its measured comparison.')
  return { _tag: value._tag as 'Accepted' | 'RejectedCandidate' | 'FixtureReviewRequired', requestId: value.requestId, reason: value.reason, comparisons }
}

function summarize(reports: MeasuredReport[], document: Buffer, dataResources: ResourceEvidence[]): SideSummary {
  return { ...statistics(reports), reports: reports.map(({ sha256, bytes, fetchTime, durationMs, metrics, transferBytes }) => ({ sha256, bytes, fetchTime, durationMs, metrics, transferBytes })), document: { sha256: hash(document), bytes: document.byteLength }, dataResources }
}

async function readSide(root: FileHandle, side: 'before' | 'after', manifest: ManifestSide, request: VitalsComparisonRequest, target: VitalsComparisonTarget, budget: { remaining: number }): Promise<{ summary: SideSummary, reports: MeasuredReport[] }> {
  const directory = await openChild(root, side)
  try {
    const reports: MeasuredReport[] = []
    for (const sample of [1, 2, 3])
      reports.push(parseReport(await readBounded(directory, `sample-${sample}.json`, limits.report, budget), request, target, manifest.url))
    const required = [...new Set(reports.flatMap(report => report.dataRequests.map(item => item.url)))].sort()
    if (JSON.stringify(required) !== JSON.stringify(manifest.dataResources.map(resource => resource.url).toSorted()))
      fail('Captured data resources do not cover the measured requests.')
    const dataResources: ResourceEvidence[] = []
    for (const [index, resource] of manifest.dataResources.entries()) {
      const buffer = await readBounded(directory, `data-${index}.bin`, limits.data, budget)
      const rows = reports.flatMap(report => report.dataRequests).filter(item => item.url === resource.url)
      const statusCode = rows[0]!.statusCode
      if (rows.some(item => item.resourceBytes !== buffer.byteLength || item.statusCode !== statusCode))
        fail('Captured data bytes do not match the measured response sizes.')
      dataResources.push({ url: resource.url, sha256: hash(buffer), bytes: buffer.byteLength, statusCode })
    }
    const document = await readBounded(directory, 'document.html', limits.document, budget)
    if (document.byteLength === 0)
      fail('The measured page document is missing.')
    return { summary: summarize(reports, document, dataResources), reports }
  }
  finally {
    await directory.close()
  }
}

function regression(before: Metrics, after: Metrics, metric: VitalsComparisonTarget['metric']): boolean {
  const increase = after[metric] - before[metric]
  return increase > thresholds[metric].absolute && (thresholds[metric].percent === 0 || before[metric] === 0 || 100 * increase / before[metric] > thresholds[metric].percent)
}

function rejectedComparison(comparison: VitalsComparisonSummary): boolean {
  const { target, before, after, improvement } = comparison
  return improvement.absolute <= improvement.requiredAbsolute || (improvement.requiredPercent > 0 && improvement.percent <= improvement.requiredPercent) || improvement.absolute <= Math.max(before.range[target.metric], after.range[target.metric]) || metricNames.some(metric => metric !== target.metric && regression(before.median, after.median, metric))
}

function changedData(comparison: VitalsComparisonSummary): boolean {
  const hashes = (side: SideSummary) => canonical(side.dataResources.toSorted((left, right) => left.url.localeCompare(right.url)))
  return hashes(comparison.before) !== hashes(comparison.after)
}

async function inspect(request: VitalsComparisonRequest, directory: string): Promise<VitalsComparisonResult> {
  const root = await openRoot(directory)
  const budget = { remaining: limits.total }
  try {
    const manifest = parseManifest(boundedJson(await readBounded(root, 'manifest.json', limits.manifest, budget)), request)
    const comparisons: VitalsComparisonSummary[] = []
    let rejected = false
    let changedFixtures = false
    for (const [index, target] of manifest.targets.entries()) {
      const targetRoot = await openChild(root, `target-${index}`)
      try {
        const before = await readSide(targetRoot, 'before', target.before, request, target, budget)
        const after = await readSide(targetRoot, 'after', target.after, request, target, budget)
        const reports = [...before.reports, ...after.reports]
        const first = reports[0]!
        for (const [sample, report] of reports.entries()) {
          if (report.settings !== first.settings || report.lighthouseVersion !== first.lighthouseVersion || report.hostUserAgent !== first.hostUserAgent || report.networkUserAgent !== first.networkUserAgent)
            fail('Lighthouse versions, Chrome, or settings differ between samples.')
          const previous = reports[sample - 1]
          if (previous && Date.parse(report.fetchTime) < Date.parse(previous.fetchTime) + previous.durationMs)
            fail('The Lighthouse samples overlap or are out of order.')
        }
        const metric = target.metric
        const comparison = { target: { path: target.path, strategy: target.strategy, metric }, before: before.summary, after: after.summary, runner: { lighthouseVersion: first.lighthouseVersion, hostUserAgent: first.hostUserAgent, networkUserAgent: first.networkUserAgent, settingsSha256: hash(first.settings), url: target.before.url }, improvement: improvement(target, before.summary, after.summary) }
        rejected ||= rejectedComparison(comparison)
        changedFixtures ||= changedData(comparison)
        comparisons.push(comparison)
      }
      finally {
        await targetRoot.close()
      }
    }
    const timeline = [...new Map(comparisons.flatMap(comparison => [...comparison.before.reports, ...comparison.after.reports]).map(report => [report.sha256, report])).values()].sort((left, right) => Date.parse(left.fetchTime) - Date.parse(right.fetchTime))
    for (const [index, report] of timeline.entries()) {
      const previous = timeline[index - 1]
      if (previous && Date.parse(report.fetchTime) < Date.parse(previous.fetchTime) + previous.durationMs)
        fail('The Lighthouse samples overlap across comparison targets.')
    }
    if (rejected)
      return { _tag: 'RejectedCandidate', requestId: request.id, reason: 'The candidate fails metric, variation, or regression acceptance. Revert the experiment.', comparisons }
    if (changedFixtures)
      return { _tag: 'FixtureReviewRequired', requestId: request.id, reason: 'Measured data resources differ. Review their meaning before accepting a performance claim.', comparisons }
    return { _tag: 'Accepted', requestId: request.id, reason: 'The measured comparison passes. Styling and interaction acceptance still require separate verification.', comparisons }
  }
  finally {
    await root.close()
  }
}

export async function readVitalsComparison(request: VitalsComparisonRequest, directory: string): Promise<VitalsComparisonResult> {
  return inspect(parseVitalsComparisonRequest(request), directory).catch((error: unknown) => {
    if (error instanceof Error && '_tag' in error && error._tag === 'InvalidVitalsEvidence')
      return { _tag: 'Unavailable', requestId: request.id, reason: error.message }
    if (error instanceof Error && 'code' in error && typeof error.code === 'string')
      return { _tag: 'Unavailable', requestId: request.id, reason: 'Required vitals artifacts are missing, unsafe, or unreadable.' }
    throw error
  })
}

export function vitalsComparisonInstructions(request: VitalsComparisonRequest, directory: string): string {
  const parsed = parseVitalsComparisonRequest(request)
  const manifest = { schemaVersion: 1, requestId: parsed.id, taskId: parsed.taskId, revisionId: parsed.revisionId, baseSha: parsed.baseSha, issuedAt: parsed.issuedAt, targets: parsed.targets.map(target => ({ ...target, before: { url: `http://localhost:4173${target.path}`, dataResources: [{ url: 'http://localhost:4173/api/example.json' }] }, after: { url: `http://localhost:4173${target.path}`, dataResources: [{ url: 'http://localhost:4173/api/example.json' }] } })) }
  return `Required Vitals comparison artifacts: ${directory}
Use umask 077. Keep every artifact private and inside this provided directory.
Write manifest.json with this request binding. Replace example URLs with the measured URLs:
${JSON.stringify(manifest, null, 2)}
For each target index N, create target-N/before and target-N/after.
Each side contains sample-1.json, sample-2.json, sample-3.json, and document.html.
Each side also contains data-0.bin onward, matching its manifest dataResources order.
Capture each measured Fetch, XHR, and JSON response body. List every distinct data URL exactly once.
Do not classify changed HTML, stylesheets, scripts, or fonts as changed data fixtures.
Use the same page URL, Lighthouse release, Chrome, and full settings on both sides.
Use simulated throttling, reset storage, separate build caches, and a fresh Chrome profile for each sample.
Run all six samples serially after this request. Preserve their original reports.
Use the repository production build and a compatible local preview.
The reader rejects missing resources, changed runner settings, overlapping samples, and weak metric gains.
Changed data requires review. Do not sort arrays or remove timestamps to manufacture fixture equality.
The reader does not verify styling, themes, hydration, navigation, or tool interactions. Verify those separately.`
}

async function prepareDirectory(request: VitalsComparisonRequest): Promise<string> {
  const home = homedir()
  const directory = vitalsEvidenceDirectory(request, home)
  let current = await openRoot(home)
  try {
    for (const [index, name] of ['scratch', 'vitals-review', request.taskId, request.id].entries()) {
      await mkdir(`/proc/self/fd/${current.fd}/${name}`, { mode: 0o700 }).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST' && index < 3)
          return // Existing parents are checked through the pinned directory before use.
        throw error
      })
      const child = await openChild(current, name)
      await current.close()
      current = child
    }
    return directory
  }
  finally {
    await current.close()
  }
}

async function main(): Promise<void> {
  const request = parseVitalsComparisonRequest(JSON.parse(process.argv[3] ?? 'null'))
  if (process.argv[2] === 'prepare') {
    if (process.argv[4] !== undefined)
      fail('Prepare uses only the fixed vitals evidence directory.')
    const directory = await prepareDirectory(request)
    process.stdout.write(`${JSON.stringify({ directory })}\n`)
    return
  }
  if (process.argv[2] !== 'verify')
    fail('Choose prepare or verify for the vitals comparison.')
  const directory = process.argv[4] ?? vitalsEvidenceDirectory(request, homedir())
  process.stdout.write(`${JSON.stringify(await readVitalsComparison(request, directory))}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'The vitals comparison failed.'}\n`)
    process.exitCode = 1
  })
}
