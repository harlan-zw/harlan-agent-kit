export interface HogwildServiceMetrics {
  cpuTimeSeconds: number
  memoryBytes: number
  restarts: number
  tasks: number
  uptimeSeconds: number
}

export type HogwildServiceState
  = | { _tag: 'Active', metrics: HogwildServiceMetrics }
    | { _tag: 'Inactive' }
    | { _tag: 'Unavailable' }

export type HogwildRunnerStatus
  = | { _tag: 'Unavailable' }
    | {
      _tag: 'Available'
      budgets: {
        cpu: number
        memoryBytes: number
        memoryHeadroomBytes: number
      }
      pools: Array<{
        cpuPerRunner: number
        live: number
        maximum: number
        memoryLimitBytes: number
        memoryReservationBytes: number
        queue: { _tag: 'Available', jobs: number } | { _tag: 'Unavailable' }
        running: number
      }>
      updatedAt: number
    }

export interface HogwildStatus {
  host: {
    cpu: string
    kernel: string
    logicalCores: number
    operatingSystem: string
  }
  load: [number, number, number]
  runners: HogwildRunnerStatus
  services: Array<{
    name: 'AdGuard Home' | 'Cloudflare Tunnel' | 'GitHub runner' | 'Jellyfin'
    state: HogwildServiceState
  }>
  temperatures:
    | { _tag: 'Available', values: Array<{ celsius: number, name: 'CPU' | 'Storage' }> }
    | { _tag: 'Unavailable' }
  updatedAt: number
}

export type ParseHogwildStatusResult
  = | { _tag: 'Ok', value: HogwildStatus }
    | { _tag: 'Err', reason: string }

type HogwildServiceName = HogwildStatus['services'][number]['name']

export interface HogwildHistory {
  load: number[]
  serviceMemoryMb: Record<HogwildServiceName, number[]>
  temperatures: Record<'CPU' | 'Storage', number[]>
  updatedAt: number
}

export interface SparklineProjection {
  end: { x: number, y: number }
  path: string
  summary: string
}

const hogwildHostname = 'hogwild.tailcad325.ts.net'
const serviceNames = ['AdGuard Home', 'Cloudflare Tunnel', 'GitHub runner', 'Jellyfin'] as const
const temperatureNames = ['CPU', 'Storage'] as const

export function emptyHogwildHistory(): HogwildHistory {
  return {
    load: [],
    serviceMemoryMb: {
      'AdGuard Home': [],
      'Cloudflare Tunnel': [],
      'GitHub runner': [],
      'Jellyfin': [],
    },
    temperatures: { CPU: [], Storage: [] },
    updatedAt: 0,
  }
}

export function appendHogwildSample(history: HogwildHistory, status: HogwildStatus, maximumSamples = 40): HogwildHistory {
  if (status.updatedAt <= history.updatedAt)
    return history
  const limit = Math.max(1, Math.floor(maximumSamples))
  const temperatures = status.temperatures._tag === 'Available'
    ? new Map(status.temperatures.values.map(value => [value.name, value.celsius]))
    : new Map<'CPU' | 'Storage', number>()
  const services = new Map(status.services.map(service => [service.name, service.state]))
  return {
    load: appendSample(history.load, status.load[0], limit),
    serviceMemoryMb: Object.fromEntries(serviceNames.map((name) => {
      const state = services.get(name)
      return [name, state?._tag === 'Active'
        ? appendSample(history.serviceMemoryMb[name], state.metrics.memoryBytes / 1024 ** 2, limit)
        : []]
    })) as Record<HogwildServiceName, number[]>,
    temperatures: {
      CPU: appendOptionalSample(history.temperatures.CPU, temperatures.get('CPU'), limit),
      Storage: appendOptionalSample(history.temperatures.Storage, temperatures.get('Storage'), limit),
    },
    updatedAt: status.updatedAt,
  }
}

export function sparklineProjection(values: number[], width = 96, height = 24): SparklineProjection | undefined {
  if (values.length < 3 || !values.every(nonNegativeNumber))
    return undefined
  const strokeWidth = 1.5
  const chartWidth = width - strokeWidth * 2
  const chartHeight = height - strokeWidth * 2
  const bounds = floorSparklineRange(minMax(values))
  const range = bounds.max - bounds.min || 1
  const points = values.map((value, index) => ({
    x: strokeWidth + index / (values.length - 1) * chartWidth,
    y: strokeWidth + chartHeight - (value - bounds.min) / range * chartHeight,
  }))
  const clampY = (value: number) => Math.min(strokeWidth + chartHeight, Math.max(strokeWidth, value))
  const segments = [`M ${points[0]?.x} ${points[0]?.y}`]
  for (let index = 0; index < points.length - 1; index++) {
    const previous = points[Math.max(index - 1, 0)]
    const current = points[index]
    const next = points[index + 1]
    const afterNext = points[Math.min(index + 2, points.length - 1)]
    if (previous === undefined || current === undefined || next === undefined || afterNext === undefined)
      return undefined
    const tension = 0.3
    const firstControlX = current.x + (next.x - previous.x) * tension
    const firstControlY = clampY(current.y + (next.y - previous.y) * tension)
    const secondControlX = next.x - (afterNext.x - current.x) * tension
    const secondControlY = clampY(next.y - (afterNext.y - current.y) * tension)
    segments.push(`C ${firstControlX} ${firstControlY}, ${secondControlX} ${secondControlY}, ${next.x} ${next.y}`)
  }
  const end = points.at(-1)
  return end === undefined
    ? undefined
    : { end, path: segments.join(' '), summary: sparklineSummary(values) }
}

export function hogwildLiveUrl(hostname: string, protocol: string): string | undefined {
  return hostname === hogwildHostname && protocol === 'https:'
    ? `wss://${hogwildHostname}/status/live`
    : undefined
}

export function parseHogwildStatus(input: string): ParseHogwildStatusResult {
  const decoded = parseJson(input)
  if (decoded._tag === 'Err')
    return decoded
  const root = decoded.value
  if (!isRecord(root)
    || !isRecord(root.access)
    || root.access._tag !== 'TailscaleAccess'
    || !isRecord(root.privateDetails)) {
    return { _tag: 'Err', reason: 'Private Hogwild status is unavailable.' }
  }
  const status = parseStatus(root.privateDetails)
  return status === undefined
    ? { _tag: 'Err', reason: 'Hogwild sent an unsupported status payload.' }
    : { _tag: 'Ok', value: status }
}

export function formatHogwildServiceMetrics(metrics: HogwildServiceMetrics): string {
  return [
    `${(metrics.memoryBytes / 1024 ** 2).toFixed(1)} MB`,
    `${metrics.tasks} tasks`,
    `up ${formatDuration(metrics.uptimeSeconds)}`,
    `${formatDuration(metrics.cpuTimeSeconds)} CPU`,
    `${metrics.restarts} restarts`,
  ].join(' · ')
}

export function formatHogwildTemperatures(temperatures: HogwildStatus['temperatures']): string {
  return temperatures._tag === 'Available'
    ? temperatures.values.map(formatHogwildTemperature).join(' · ')
    : 'Unavailable'
}

export function formatHogwildTemperature(temperature: { celsius: number, name: 'CPU' | 'Storage' }): string {
  return `${temperature.name} ${temperature.celsius.toFixed(1)}°C`
}

export function formatHogwildLoad(load: HogwildStatus['load']): string {
  return load.map(value => value.toFixed(2)).join(' · ')
}

export function formatHogwildHost(host: HogwildStatus['host']): string {
  return `${host.cpu} · ${host.logicalCores} logical cores · ${host.operatingSystem} ${host.kernel}`
}

export function formatHogwildRunnerCapacity(status: HogwildRunnerStatus): string {
  if (status._tag === 'Unavailable')
    return 'Unavailable'

  const running = sum(status.pools, pool => pool.running)
  const queued = status.pools.every(pool => pool.queue._tag === 'Available')
    ? String(sum(status.pools, pool => pool.queue._tag === 'Available' ? pool.queue.jobs : 0))
    : 'Unavailable'
  const live = sum(status.pools, pool => pool.live)
  const maximum = sum(status.pools, pool => pool.maximum)
  const cpuReserved = sum(status.pools, pool => pool.live * pool.cpuPerRunner)
  const memoryReserved = sum(status.pools, pool => pool.live * pool.memoryReservationBytes)
  const largestHardLimit = Math.max(0, ...status.pools.map(pool => pool.memoryLimitBytes))

  return `${running} running · ${queued} queued · ${live} / ${maximum} live · ${cpuReserved} / ${status.budgets.cpu} CPU reserved · ${formatGibibytes(memoryReserved)} / ${formatGibibytes(status.budgets.memoryBytes)} memory reserved · ${formatGibibytes(largestHardLimit)} largest hard limit · keeps ${formatGibibytes(status.budgets.memoryHeadroomBytes)} available`
}

function formatGibibytes(bytes: number): string {
  const gibibytes = bytes / 1024 ** 3
  return `${Number.isInteger(gibibytes) ? gibibytes : gibibytes.toFixed(1)} GiB`
}

function sum<Value>(values: Value[], select: (value: Value) => number): number {
  return values.reduce((total, value) => total + select(value), 0)
}

function formatDuration(seconds: number): string {
  if (seconds >= 86_400)
    return `${Math.floor(seconds / 86_400)}d ${Math.floor(seconds % 86_400 / 3_600)}h`
  if (seconds >= 3_600)
    return `${Math.floor(seconds / 3_600)}h ${Math.floor(seconds % 3_600 / 60)}m`
  if (seconds >= 60)
    return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
  return `${seconds}s`
}

function parseJson(input: string): { _tag: 'Ok', value: unknown } | { _tag: 'Err', reason: string } {
  try {
    return { _tag: 'Ok', value: JSON.parse(input) as unknown }
  }
  catch {
    return { _tag: 'Err', reason: 'Hogwild sent invalid JSON.' }
  }
}

function parseStatus(value: Record<string, unknown>): HogwildStatus | undefined {
  const host = parseHost(value.host)
  const load = parseLoad(value.load)
  const runners = parseRunners(value.runners)
  const services = parseServices(value.services)
  const temperatures = parseTemperatures(value.temperatures)
  const updatedAt = count(value.updatedAt)
  if (host === undefined
    || load === undefined
    || runners === undefined
    || services === undefined
    || temperatures === undefined
    || updatedAt === undefined) {
    return undefined
  }
  return { host, load, runners, services, temperatures, updatedAt }
}

function parseRunners(value: unknown): HogwildRunnerStatus | undefined {
  if (!isRecord(value))
    return undefined
  if (value._tag === 'Unavailable')
    return { _tag: 'Unavailable' }
  if (value._tag !== 'Available' || !isRecord(value.budgets) || !Array.isArray(value.pools))
    return undefined
  const cpu = count(value.budgets.cpu)
  const memoryBytes = count(value.budgets.memoryBytes)
  const memoryHeadroomBytes = count(value.budgets.memoryHeadroomBytes)
  const updatedAt = count(value.updatedAt)
  if (cpu === undefined
    || memoryBytes === undefined
    || memoryHeadroomBytes === undefined
    || updatedAt === undefined) {
    return undefined
  }
  const pools = value.pools.map(parseRunnerPool)
  if (pools.includes(undefined))
    return undefined
  return {
    _tag: 'Available',
    budgets: {
      cpu,
      memoryBytes,
      memoryHeadroomBytes,
    },
    pools: pools as Extract<HogwildRunnerStatus, { _tag: 'Available' }>['pools'],
    updatedAt,
  }
}

function parseRunnerPool(value: unknown): Extract<HogwildRunnerStatus, { _tag: 'Available' }>['pools'][number] | undefined {
  if (!isRecord(value))
    return undefined
  const cpuPerRunner = count(value.cpuPerRunner)
  const live = count(value.live)
  const maximum = count(value.maximum)
  const memoryLimitBytes = count(value.memoryLimitBytes)
  const memoryReservationBytes = count(value.memoryReservationBytes)
  const running = count(value.running)
  if (cpuPerRunner === undefined
    || live === undefined
    || maximum === undefined
    || memoryLimitBytes === undefined
    || memoryReservationBytes === undefined
    || memoryReservationBytes > memoryLimitBytes
    || running === undefined) {
    return undefined
  }
  const queue = parseRunnerQueue(value.queue)
  return queue === undefined
    ? undefined
    : {
        cpuPerRunner,
        live,
        maximum,
        memoryLimitBytes,
        memoryReservationBytes,
        queue,
        running,
      }
}

function parseRunnerQueue(value: unknown): Extract<HogwildRunnerStatus, { _tag: 'Available' }>['pools'][number]['queue'] | undefined {
  if (!isRecord(value))
    return undefined
  if (value._tag === 'Unavailable')
    return { _tag: 'Unavailable' }
  const jobs = count(value.jobs)
  return value._tag === 'Available' && jobs !== undefined
    ? { _tag: 'Available', jobs }
    : undefined
}

function parseHost(value: unknown): HogwildStatus['host'] | undefined {
  if (!isRecord(value)
    || !nonEmptyString(value.cpu)
    || !nonEmptyString(value.kernel)
    || !nonEmptyString(value.operatingSystem)) {
    return undefined
  }
  const logicalCores = count(value.logicalCores)
  if (logicalCores === undefined)
    return undefined
  return {
    cpu: value.cpu,
    kernel: value.kernel,
    logicalCores,
    operatingSystem: value.operatingSystem,
  }
}

function parseLoad(value: unknown): HogwildStatus['load'] | undefined {
  if (!Array.isArray(value) || value.length !== 3)
    return undefined
  const [oneMinute, fiveMinutes, fifteenMinutes] = value
  if (!nonNegativeNumber(oneMinute) || !nonNegativeNumber(fiveMinutes) || !nonNegativeNumber(fifteenMinutes))
    return undefined
  return [oneMinute, fiveMinutes, fifteenMinutes]
}

function parseServices(value: unknown): HogwildStatus['services'] | undefined {
  if (!Array.isArray(value))
    return undefined
  const services = value.map(parseService)
  return services.every(service => service !== undefined)
    ? services
    : undefined
}

function parseService(value: unknown): HogwildStatus['services'][number] | undefined {
  if (!isRecord(value) || !oneOf(value.name, serviceNames))
    return undefined
  const state = parseServiceState(value.state)
  return state === undefined ? undefined : { name: value.name, state }
}

function parseServiceState(value: unknown): HogwildServiceState | undefined {
  if (!isRecord(value))
    return undefined
  if (value._tag === 'Inactive' || value._tag === 'Unavailable')
    return { _tag: value._tag }
  if (value._tag !== 'Active' || !isRecord(value.metrics))
    return undefined
  const cpuTimeSeconds = value.metrics.cpuTimeSeconds
  const memoryBytes = count(value.metrics.memoryBytes)
  const restarts = count(value.metrics.restarts)
  const tasks = count(value.metrics.tasks)
  const uptimeSeconds = count(value.metrics.uptimeSeconds)
  if (!nonNegativeNumber(cpuTimeSeconds)
    || memoryBytes === undefined
    || restarts === undefined
    || tasks === undefined
    || uptimeSeconds === undefined) {
    return undefined
  }
  return {
    _tag: 'Active',
    metrics: { cpuTimeSeconds, memoryBytes, restarts, tasks, uptimeSeconds },
  }
}

function parseTemperatures(value: unknown): HogwildStatus['temperatures'] | undefined {
  if (!isRecord(value))
    return undefined
  if (value._tag === 'Unavailable')
    return { _tag: 'Unavailable' }
  if (value._tag !== 'Available' || !Array.isArray(value.values))
    return undefined
  const values = value.values.map(parseTemperature)
  return values.every(temperature => temperature !== undefined)
    ? { _tag: 'Available', values }
    : undefined
}

function parseTemperature(value: unknown): { celsius: number, name: 'CPU' | 'Storage' } | undefined {
  if (!isRecord(value) || !oneOf(value.name, temperatureNames) || !Number.isFinite(value.celsius))
    return undefined
  return { celsius: value.celsius as number, name: value.name }
}

function appendSample(values: number[], value: number, limit: number): number[] {
  return [...values, value].slice(-limit)
}

function appendOptionalSample(values: number[], value: number | undefined, limit: number): number[] {
  return value === undefined ? [] : appendSample(values, value, limit)
}

function minMax(values: number[]): { max: number, min: number } {
  return values.reduce((bounds, value) => ({
    max: Math.max(bounds.max, value),
    min: Math.min(bounds.min, value),
  }), { max: -Infinity, min: Infinity })
}

/** Small jitter should stay small instead of filling the chart height. */
function floorSparklineRange(bounds: { max: number, min: number }): { max: number, min: number } {
  const spread = bounds.max - bounds.min
  const minimumRange = Math.max(Math.abs(bounds.max), Math.abs(bounds.min)) * 0.08
  if (spread >= minimumRange)
    return bounds
  const middle = (bounds.max + bounds.min) / 2
  const range = minimumRange || 1
  return { max: middle + range / 2, min: middle - range / 2 }
}

function sparklineSummary(values: number[]): string {
  const middle = Math.floor(values.length / 2)
  const early = mean(values.slice(0, middle))
  const recent = mean(values.slice(middle))
  const base = Math.max(Math.abs(early), Math.abs(recent))
  const direction = base === 0 || Math.abs(recent - early) / base < 0.02
    ? 'flat'
    : recent > early ? 'upward' : 'downward'
  return `${direction} trend, averaging ${formatSparklineNumber(early)} early to ${formatSparklineNumber(recent)} recently`
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length
}

function formatSparklineNumber(value: number): string {
  return Math.abs(value) >= 10 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(2)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function count(value: unknown): number | undefined {
  return nonNegativeNumber(value) && Number.isSafeInteger(value) ? value : undefined
}

function oneOf<const Values extends readonly string[]>(value: unknown, values: Values): value is Values[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}
