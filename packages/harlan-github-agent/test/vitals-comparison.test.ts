import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { parseVitalsComparisonRequest, parseVitalsComparisonResult, readVitalsComparison, vitalsEvidenceDirectory } from '../src/vitals-comparison.ts'

const execute = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vitals-evidence-'))
  roots.push(directory)
  const request = parseVitalsComparisonRequest({ id: '12345678-1234-4123-8123-123456789012', taskId: 'task-123', revisionId: 'b'.repeat(64), baseSha: 'a'.repeat(40), issuedAt: new Date(Date.now() - 60_000).toISOString(), targets: [{ path: '/tools/schema-validator', strategy: 'mobile', metric: 'lcp' }] })
  const url = 'http://localhost:4173/tools/schema-validator'
  const resource = 'http://localhost:4173/api/stats.json'
  const manifest = { schemaVersion: 1, requestId: request.id, taskId: request.taskId, revisionId: request.revisionId, baseSha: request.baseSha, issuedAt: request.issuedAt, targets: [{ ...request.targets[0], before: { url, dataResources: [{ url: resource }] }, after: { url, dataResources: [{ url: resource }] } }] }
  const reports: Record<string, any> = {}
  for (const [sideIndex, side] of ['before', 'after'].entries()) {
    const sideDirectory = join(directory, 'target-0', side)
    await mkdir(sideDirectory, { recursive: true, mode: 0o700 })
    await writeFile(join(sideDirectory, 'document.html'), side === 'before' ? '<p>Before with larger inline CSS</p>' : '<p>After</p>', { mode: 0o600 })
    await writeFile(join(sideDirectory, 'data-0.bin'), '{"count":10}', { mode: 0o600 })
    for (const sample of [1, 2, 3]) {
      const jitter = (sample - 2) * 50
      const report = {
        lighthouseVersion: '13.4.0',
        requestedUrl: url,
        finalDisplayedUrl: url,
        fetchTime: new Date(Date.parse(request.issuedAt) + 1000 + sideIndex * 20_000 + sample * 3000).toISOString(),
        runWarnings: [],
        configSettings: { formFactor: 'mobile', throttlingMethod: 'simulate', disableStorageReset: false, screenEmulation: { mobile: true, disabled: false }, throttling: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 } },
        environment: { hostUserAgent: 'Chrome/154.0.0', networkUserAgent: 'Chrome/154.0.0 Mobile' },
        timing: { total: 500 },
        audits: {
          'largest-contentful-paint': { numericValue: (side === 'before' ? 5000 : 2800) + jitter },
          'first-contentful-paint': { numericValue: (side === 'before' ? 3000 : 2000) + jitter },
          'total-blocking-time': { numericValue: 100 },
          'cumulative-layout-shift': { numericValue: 0.05 },
          'total-byte-weight': { numericValue: side === 'before' ? 900_000 : 800_000 },
          'network-requests': { details: { items: [{ url: resource, resourceType: 'Fetch', mimeType: 'application/json', statusCode: 200, resourceSize: 12 }, { url, resourceType: 'Document', mimeType: 'text/html', statusCode: 200, resourceSize: 100 }] } },
        },
      }
      reports[`${side}-${sample}`] = report
      await writeFile(join(sideDirectory, `sample-${sample}.json`), JSON.stringify(report), { mode: 0o600 })
    }
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
  const change = async (side: string, sample: number, update: (report: any) => void) => {
    const report = reports[`${side}-${sample}`]
    update(report)
    await writeFile(join(directory, 'target-0', side, `sample-${sample}.json`), JSON.stringify(report), { mode: 0o600 })
  }
  return { directory, request, manifest, reports, change }
}

it('accepts six comparable cold reports with a measured target benefit and records changing HTML', async () => {
  const { directory, request } = await fixture()
  const result = await readVitalsComparison(request, directory)
  expect(result._tag).toBe('Accepted')
  if (result._tag !== 'Accepted')
    throw new Error(result.reason)
  expect(result.comparisons[0]?.before.median.lcp).toBe(5000)
  expect(result.comparisons[0]?.after.median.lcp).toBe(2800)
  expect(result.comparisons[0]?.before.transferBytes.median).toBe(900_000)
  expect(result.comparisons[0]?.after.transferBytes.median).toBe(800_000)
  expect(result.comparisons[0]?.before.document.sha256).not.toBe(result.comparisons[0]?.after.document.sha256)
  expect(result.comparisons[0]?.before.reports.map(report => report.sha256)).toHaveLength(3)
})

it('rejects a weak candidate before classifying changed fixture bytes', async () => {
  const { directory, request, change } = await fixture()
  for (const sample of [1, 2, 3]) await change('after', sample, report => report.audits['largest-contentful-paint'].numericValue = 4900)
  await writeFile(join(directory, 'target-0', 'after', 'data-0.bin'), '{"count":11}', { mode: 0o600 })
  expect((await readVitalsComparison(request, directory))._tag).toBe('RejectedCandidate')
})

it('rejects a target benefit when another paint metric regresses materially', async () => {
  const { directory, request, change } = await fixture()
  for (const sample of [1, 2, 3]) await change('after', sample, report => report.audits['first-contentful-paint'].numericValue = 4500)
  expect((await readVitalsComparison(request, directory))._tag).toBe('RejectedCandidate')
})

it('requires fixture review when data changes despite acceptable paint metrics', async () => {
  const { directory, request } = await fixture()
  await writeFile(join(directory, 'target-0', 'after', 'data-0.bin'), '{"count":11}', { mode: 0o600 })
  expect((await readVitalsComparison(request, directory))._tag).toBe('FixtureReviewRequired')
})

it('accepts identical captured anonymous error responses while requiring a successful document', async () => {
  const { directory, request, change } = await fixture()
  for (const side of ['before', 'after']) {
    for (const sample of [1, 2, 3])
      await change(side, sample, report => report.audits['network-requests'].details.items[0].statusCode = 401)
  }
  const result = await readVitalsComparison(request, directory)
  expect(result._tag).toBe('Accepted')
  if (result._tag === 'Accepted')
    expect(result.comparisons[0]?.before.dataResources[0]?.statusCode).toBe(401)
})

it('requires fixture review when a data response status changes with identical bytes', async () => {
  const { directory, request, change } = await fixture()
  for (const sample of [1, 2, 3])
    await change('after', sample, report => report.audits['network-requests'].details.items[0].statusCode = 401)
  expect((await readVitalsComparison(request, directory))._tag).toBe('FixtureReviewRequired')
})

it('refuses an error document even when the paint numbers improve', async () => {
  const { directory, request, change } = await fixture()
  await change('after', 1, report => report.audits['network-requests'].details.items[1].statusCode = 404)
  expect((await readVitalsComparison(request, directory))._tag).toBe('Unavailable')
})

it.each(['settings', 'chrome', 'version', 'warm', 'error', 'warning', 'stale', 'overlap'])('refuses %s evidence instead of claiming a repair', async (kind) => {
  const { directory, request, change } = await fixture()
  await change('after', 2, (report) => {
    if (kind === 'settings')
      report.configSettings.throttling.cpuSlowdownMultiplier = 1
    if (kind === 'chrome')
      report.environment.hostUserAgent = 'Chrome/155.0.0'
    if (kind === 'version')
      report.lighthouseVersion = '13.5.0'
    if (kind === 'warm')
      report.configSettings.disableStorageReset = true
    if (kind === 'error')
      report.runtimeError = { code: 'FAILED_DOCUMENT_REQUEST' }
    if (kind === 'warning')
      report.runWarnings = ['Evidence is incomplete.']
    if (kind === 'stale')
      report.fetchTime = new Date(Date.parse(request.issuedAt) - 30_000).toISOString()
    if (kind === 'overlap')
      report.fetchTime = new Date(Date.parse(request.issuedAt) + 24_001).toISOString()
  })
  expect((await readVitalsComparison(request, directory))._tag).toBe('Unavailable')
})

it('refuses a manifest that omits measured data resources', async () => {
  const { directory, request, manifest } = await fixture()
  manifest.targets[0]!.before.dataResources = []
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
  expect((await readVitalsComparison(request, directory))._tag).toBe('Unavailable')
})

it.each(['symlink-file', 'symlink-directory', 'public', 'oversized', 'replay', 'missing'])('refuses %s artifacts without following model paths', async (kind) => {
  const { directory, request, manifest } = await fixture()
  const file = join(directory, 'target-0', 'after', 'sample-1.json')
  if (kind === 'symlink-file') {
    const other = join(directory, 'other.json')
    await copyFile(file, other)
    await rm(file)
    await symlink(other, file)
  }
  if (kind === 'symlink-directory') {
    const original = join(directory, 'target-0', 'after')
    const external = join(directory, 'elsewhere')
    await mkdir(external, { mode: 0o700 })
    await copyFile(file, join(external, 'sample-1.json'))
    await rm(original, { recursive: true })
    await symlink(external, original)
  }
  if (kind === 'public')
    await chmod(file, 0o644)
  if (kind === 'oversized')
    await writeFile(file, ' '.repeat(2 * 1024 * 1024 + 1), { mode: 0o600 })
  if (kind === 'replay') {
    manifest.requestId = '87654321-4321-4321-8321-123456789012'
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
  }
  if (kind === 'missing')
    await rm(file)
  expect((await readVitalsComparison(request, directory))._tag).toBe('Unavailable')
})

it('parses returned evidence at a boundary and rejects malformed accepted claims', async () => {
  const { directory, request } = await fixture()
  const result = await readVitalsComparison(request, directory)
  expect(parseVitalsComparisonResult(JSON.parse(JSON.stringify(result)))).toEqual(result)
  expect(() => parseVitalsComparisonResult({ _tag: 'Accepted', requestId: request.id, reason: 'Trust me.', comparisons: [] })).toThrow()
  expect(() => vitalsEvidenceDirectory({ ...request, taskId: '../other' }, '/home/agent')).toThrow()
})

it.each(['summary', 'decision', 'fixture-status'])('rejects an inconsistent %s from the desktop result boundary', async (kind) => {
  const { directory, request } = await fixture()
  const result = await readVitalsComparison(request, directory)
  if (result._tag !== 'Accepted')
    throw new Error(result.reason)
  const comparison = result.comparisons[0]!
  if (kind === 'summary')
    comparison.before.median.lcp = 8000
  if (kind === 'decision') {
    for (const report of comparison.after.reports)
      report.metrics.lcp = 4900
    comparison.after.median.lcp = 4900
    comparison.after.range.lcp = 0
    comparison.improvement.absolute = 100
    comparison.improvement.percent = 2
  }
  if (kind === 'fixture-status')
    comparison.after.dataResources[0]!.statusCode = 401
  expect(() => parseVitalsComparisonResult(result)).toThrow()
})

it('verifies from a copied standalone TypeScript entry without repository imports', async () => {
  const { directory, request } = await fixture()
  const copied = join(directory, 'standalone comparison.ts')
  await copyFile(fileURLToPath(new URL('../src/vitals-comparison.ts', import.meta.url)), copied)
  const result = await execute(process.execPath, ['--experimental-strip-types', copied, 'verify', JSON.stringify(request), directory])
  expect(parseVitalsComparisonResult(JSON.parse(result.stdout))._tag).toBe('Accepted')
})

it('does not create evidence through a symlinked preparation parent', async () => {
  const { directory, request } = await fixture()
  const external = await mkdtemp(join(tmpdir(), 'vitals-outside-'))
  roots.push(external)
  await symlink(external, join(directory, 'scratch'))
  const source = fileURLToPath(new URL('../src/vitals-comparison.ts', import.meta.url))
  const outcome = await execute(process.execPath, ['--experimental-strip-types', source, 'prepare', JSON.stringify(request)], { env: { ...process.env, HOME: directory } })
    .then(() => ({ _tag: 'Created' as const }))
    .catch((error: { code: number }) => ({ _tag: 'Rejected' as const, code: error.code }))
  expect(outcome).toEqual({ _tag: 'Rejected', code: 1 })
  expect(await readdir(external)).toEqual([])
})

it('creates one fresh fixed evidence directory and refuses to reuse it', async () => {
  const { directory, request } = await fixture()
  const source = fileURLToPath(new URL('../src/vitals-comparison.ts', import.meta.url))
  const args = ['--experimental-strip-types', source, 'prepare', JSON.stringify(request)]
  const options = { env: { ...process.env, HOME: directory } }
  const outcome = await execute(process.execPath, args, options)
  expect(JSON.parse(outcome.stdout)).toEqual({ directory: vitalsEvidenceDirectory(request, directory) })
  await expect(execute(process.execPath, args, options)).rejects.toMatchObject({ code: 1 })
})

it.each([
  ['fcp', 'first-contentful-paint', 4000, 2000],
  ['tbt', 'total-blocking-time', 1000, 200],
  ['cls', 'cumulative-layout-shift', 0.4, 0.1],
] as const)('applies the %s metric threshold without changing the target', async (metric, audit, before, after) => {
  const { directory, request, manifest, change } = await fixture()
  const current = { ...request, targets: [{ ...request.targets[0]!, metric }] }
  manifest.targets[0]!.metric = metric
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
  for (const sample of [1, 2, 3]) {
    await change('before', sample, report => report.audits[audit].numericValue = before)
    await change('after', sample, report => report.audits[audit].numericValue = after)
  }
  expect((await readVitalsComparison(current, directory))._tag).toBe('Accepted')
})
