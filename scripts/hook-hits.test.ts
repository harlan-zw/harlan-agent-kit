import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { hitLogPath, isoWeek, parseHitLog, summariseHits } from './hook-hits.ts'

const script = fileURLToPath(new URL('./hook-hits.ts', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'hook-hits-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

function line(time: string, hook: string, surface: string, decision = 'deny'): string {
  return JSON.stringify({ time, hook, decision, surface, reason: 'Use wt, not git worktree.' })
}

describe('isoWeek', () => {
  it.each([
    ['2026-11-18T12:00:00Z', '2026-W47'],
    ['2026-11-22T23:30:00Z', '2026-W47'],
    ['2026-11-23T00:00:00Z', '2026-W48'],
    // ISO weeks cross the calendar year. 2026 starts on a Thursday, so it has 53 weeks.
    ['2025-12-29T00:00:00Z', '2026-W01'],
    ['2027-01-01T23:59:59Z', '2026-W53'],
    ['2027-01-04T00:00:00Z', '2027-W01'],
  ])('reads %s as %s in UTC', (time, week) => {
    expect(isoWeek(new Date(time))).toBe(week)
  })
})

describe('parseHitLog', () => {
  it('counts malformed lines and skips blank ones', () => {
    const text = [
      line('2026-11-18T01:00:00Z', 'wt-only.sh', 'claude'),
      '{not json',
      JSON.stringify({ time: '2026-11-18T01:00:00Z', hook: 'wt-only.sh', decision: 'allow', surface: 'claude', reason: '' }),
      JSON.stringify({ time: 'yesterday', hook: 'wt-only.sh', decision: 'deny', surface: 'claude', reason: '' }),
      JSON.stringify({ time: '2026-11-18T01:00:00Z', decision: 'deny', surface: 'claude', reason: '' }),
      '',
      line('2026-11-18T02:00:00Z', 'pnpm-only.sh', 'codex', 'rewrite'),
      '',
    ].join('\n')
    const parsed = parseHitLog(text)
    expect(parsed.hits.map(hit => [hit.hook, hit.decision, hit.surface])).toEqual([
      ['wt-only.sh', 'deny', 'claude'],
      ['pnpm-only.sh', 'rewrite', 'codex'],
    ])
    expect(parsed.malformed.map(entry => entry.line)).toEqual([2, 3, 4, 5])
  })
})

describe('summariseHits', () => {
  it('counts hits per ISO week, per Hook, per surface', () => {
    const { hits } = parseHitLog([
      line('2026-11-16T00:00:00Z', 'wt-only.sh', 'claude'),
      line('2026-11-22T23:59:59Z', 'wt-only.sh', 'claude'),
      line('2026-11-18T00:00:00Z', 'wt-only.sh', 'codex'),
      line('2026-11-18T00:00:00Z', 'pnpm-only.sh', 'claude', 'rewrite'),
      line('2026-11-18T00:00:00Z', 'pnpm-only.sh', 'claude', 'rewrite'),
      line('2026-11-18T00:00:00Z', 'pnpm-only.sh', 'claude', 'rewrite'),
      line('2026-11-23T00:00:00Z', 'wt-only.sh', 'claude'),
      line('2026-11-10T00:00:00Z', 'github-read-routing.sh', 'opencode'),
      line('2026-11-10T00:00:00Z', 'wt-only.sh', 'antigravity'),
    ].join('\n'))
    expect(summariseHits(hits)).toEqual([
      { week: '2026-W46', hook: 'github-read-routing.sh', surface: 'opencode', hits: 1 },
      { week: '2026-W46', hook: 'wt-only.sh', surface: 'antigravity', hits: 1 },
      { week: '2026-W47', hook: 'pnpm-only.sh', surface: 'claude', hits: 3 },
      { week: '2026-W47', hook: 'wt-only.sh', surface: 'claude', hits: 2 },
      { week: '2026-W47', hook: 'wt-only.sh', surface: 'codex', hits: 1 },
      { week: '2026-W48', hook: 'wt-only.sh', surface: 'claude', hits: 1 },
    ])
  })
})

describe('hitLogPath', () => {
  it('follows XDG_STATE_HOME, then HOME', () => {
    expect(hitLogPath({ XDG_STATE_HOME: '/state' }, '/home/x')).toBe('/state/harlan-agent-kit/hook-hits.jsonl')
    expect(hitLogPath({ XDG_STATE_HOME: '' }, '/home/x')).toBe('/home/x/.local/state/harlan-agent-kit/hook-hits.jsonl')
    expect(hitLogPath({}, '/home/x')).toBe('/home/x/.local/state/harlan-agent-kit/hook-hits.jsonl')
  })
})

describe('hook-hits CLI', () => {
  function run(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null, stdout: string, stderr: string } {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: join(work, 'home'), ...env },
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  it('prints the weekly table and names malformed lines', () => {
    const state = join(work, 'state')
    const log = hitLogPath({ XDG_STATE_HOME: state }, '/unused')
    mkdirSync(join(state, 'harlan-agent-kit'), { recursive: true })
    writeFileSync(log, `${[
      line('2026-11-18T00:00:00Z', 'wt-only.sh', 'claude'),
      line('2026-11-19T00:00:00Z', 'wt-only.sh', 'claude'),
      'broken',
    ].join('\n')}\n`)
    const result = run([], { XDG_STATE_HOME: state })
    expect(result.status).toBe(0)
    expect(result.stdout.trimEnd().split('\n').map(row => row.trim().split(/\s+/).join(' '))).toEqual([
      'week hook surface hits',
      '2026-W47 wt-only.sh claude 2',
    ])
    expect(result.stderr).toBe(`Skipped 1 malformed line in ${log}: line 3.\n`)
  })

  it('reads another log with --file', () => {
    const log = join(work, 'other.jsonl')
    writeFileSync(log, `${line('2026-11-18T00:00:00Z', 'pr-skill-only.sh', 'opencode')}\n`)
    const result = run(['--file', log])
    expect(result.stdout).toMatch(/2026-W47 +pr-skill-only\.sh +opencode +1/)
    expect(result.stderr).toBe('')
  })

  it('says so when nothing is logged yet', () => {
    const log = join(work, 'missing.jsonl')
    expect(run(['--file', log])).toEqual({ status: 0, stdout: `No Hook hits logged at ${log}.\n`, stderr: '' })
  })

  it('rejects an unknown option', () => {
    const result = run(['--week'])
    expect(result.status).toBe(64)
    expect(result.stderr).toContain('--file')
  })
})
