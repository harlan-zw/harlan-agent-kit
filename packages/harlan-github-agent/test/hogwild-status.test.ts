import type { HogwildStatus } from '../dashboard/app/utils/hogwild-status.ts'
import { describe, expect, it } from 'vitest'
import {
  appendHogwildSample,
  emptyHogwildHistory,
  formatHogwildHost,
  formatHogwildLoad,
  formatHogwildServiceMetrics,
  formatHogwildTemperature,
  formatHogwildTemperatures,
  hogwildLiveUrl,
  parseHogwildStatus,
  sparklineProjection,
} from '../dashboard/app/utils/hogwild-status.ts'

const details: HogwildStatus = {
  host: {
    cpu: 'Intel(R) Core(TM) Ultra 9 285HX',
    kernel: '7.0.0-30-generic',
    logicalCores: 24,
    operatingSystem: 'Linux',
  },
  load: [0.2, 0.4, 1.02],
  services: [
    {
      name: 'Jellyfin',
      state: {
        _tag: 'Active',
        metrics: {
          cpuTimeSeconds: 8,
          memoryBytes: 103_337_984,
          restarts: 0,
          tasks: 19,
          uptimeSeconds: 16_494,
        },
      },
    },
    { name: 'AdGuard Home', state: { _tag: 'Inactive' } },
    { name: 'Cloudflare Tunnel', state: { _tag: 'Unavailable' } },
  ],
  temperatures: {
    _tag: 'Available',
    values: [
      { celsius: 41, name: 'CPU' },
      { celsius: 54.9, name: 'Storage' },
    ],
  },
  updatedAt: 1_787_899_378_238,
}

const activeStatus = {
  access: { _tag: 'TailscaleAccess' },
  privateDetails: details,
}

describe('hogwild status boundary', () => {
  it('parses private host and service data once at the boundary', () => {
    expect(parseHogwildStatus(JSON.stringify(activeStatus))).toEqual({
      _tag: 'Ok',
      value: activeStatus.privateDetails,
    })
  })

  it('accepts fractional CPU time reported by systemd', () => {
    const payload = structuredClone(activeStatus)
    const jellyfin = payload.privateDetails.services[0]
    if (jellyfin?.state._tag !== 'Active')
      throw new Error('Expected an active Jellyfin fixture.')
    jellyfin.state.metrics.cpuTimeSeconds = 8.25

    expect(parseHogwildStatus(JSON.stringify(payload))).toEqual({
      _tag: 'Ok',
      value: payload.privateDetails,
    })
  })

  it('rejects public, malformed, and partial messages', () => {
    expect(parseHogwildStatus('{}')).toEqual({ _tag: 'Err', reason: 'Private Hogwild status is unavailable.' })
    expect(parseHogwildStatus('{')).toEqual({ _tag: 'Err', reason: 'Hogwild sent invalid JSON.' })
    expect(parseHogwildStatus(JSON.stringify({
      ...activeStatus,
      privateDetails: { ...activeStatus.privateDetails, load: [0.2, 0.4] },
    }))).toEqual({ _tag: 'Err', reason: 'Hogwild sent an unsupported status payload.' })
  })

  it('connects only from the private Hogwild dashboard origin', () => {
    expect(hogwildLiveUrl('hogwild.tailcad325.ts.net', 'https:')).toBe('wss://hogwild.tailcad325.ts.net/status/live')
    expect(hogwildLiveUrl('localhost', 'http:')).toBeUndefined()
    expect(hogwildLiveUrl('hogwild.harlanzw.com', 'https:')).toBeUndefined()
  })

  it('formats active metrics for one dense service row', () => {
    const jellyfin = activeStatus.privateDetails.services[0]
    if (jellyfin?.state._tag !== 'Active')
      throw new Error('Expected an active Jellyfin fixture.')
    expect(formatHogwildServiceMetrics(jellyfin.state.metrics)).toBe('98.6 MB · 19 tasks · up 4h 34m · 8s CPU · 0 restarts')
  })

  it('formats host readings consistently with the status page', () => {
    const details = activeStatus.privateDetails
    expect(formatHogwildTemperature({ celsius: 41, name: 'CPU' })).toBe('CPU 41.0°C')
    expect(formatHogwildTemperatures(details.temperatures)).toBe('CPU 41.0°C · Storage 54.9°C')
    expect(formatHogwildLoad(details.load)).toBe('0.20 · 0.40 · 1.02')
    expect(formatHogwildHost(details.host)).toBe('Intel(R) Core(TM) Ultra 9 285HX · 24 logical cores · Linux 7.0.0-30-generic')
  })

  it('appends each live poll once and keeps a bounded recent window', () => {
    const next: HogwildStatus = {
      ...details,
      load: [0.4, 0.5, 0.6],
      services: details.services.map(service => service.name === 'Jellyfin'
        ? {
            ...service,
            state: {
              _tag: 'Active',
              metrics: {
                cpuTimeSeconds: 9,
                memoryBytes: 110_100_480,
                restarts: 0,
                tasks: 20,
                uptimeSeconds: 16_509,
              },
            },
          }
        : service),
      temperatures: { _tag: 'Available', values: [{ celsius: 42, name: 'CPU' }, { celsius: 55.1, name: 'Storage' }] },
      updatedAt: details.updatedAt + 15_000,
    }
    let history = appendHogwildSample(emptyHogwildHistory(), details, 2)
    history = appendHogwildSample(history, details, 2)
    history = appendHogwildSample(history, next, 2)
    history = appendHogwildSample(history, { ...next, load: [0.6, 0.7, 0.8], updatedAt: next.updatedAt + 15_000 }, 2)

    expect(history.load).toEqual([0.4, 0.6])
    expect(history.temperatures.CPU).toEqual([42, 42])
    expect(history.serviceMemoryMb.Jellyfin).toEqual([105, 105])
  })

  it('projects three or more readings into an accessible sparkline', () => {
    expect(sparklineProjection([10, 11])).toBeUndefined()
    expect(sparklineProjection([10, 11, 12])).toMatchObject({
      end: { x: 94.5, y: 1.5 },
      summary: 'upward trend, averaging 10 early to 12 recently',
    })
  })
})
