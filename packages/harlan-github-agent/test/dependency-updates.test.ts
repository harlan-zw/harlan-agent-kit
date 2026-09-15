import { describe, expect, it } from 'vitest'
import { parseDependencyUpdates } from '../src/dependency-updates.ts'

const update = { manifest: 'pnpm-workspace.yaml', name: 'nuxt', current: '4.0.0', latest: '5.0.0' }
const answer = (updates: unknown[]) => ({ outcome: 'complete', report: 'Registry scan completed.', updates })

describe('dependency update proposals', () => {
  it('surfaces a failed registry read', () => {
    expect(parseDependencyUpdates({ outcome: 'blocked', report: 'Registry authentication failed.', updates: [] }))
      .toEqual({ _tag: 'Err', error: 'Dependency scan blocked: Registry authentication failed.' })
  })

  it('combines majors and other updates into one reproducible proposal', () => {
    const updates = [update, { ...update, name: 'vue', current: '3.5.0', latest: '3.6.0' }]
    const first = parseDependencyUpdates(answer(updates))
    const reordered = parseDependencyUpdates(answer([...updates].reverse()))
    expect(first._tag).toBe('Ok')
    if (first._tag !== 'Ok' || reordered._tag !== 'Ok')
      throw new Error('Expected a dependency proposal.')
    expect(first.value.candidates).toHaveLength(1)
    expect(first.value.candidates[0]?.claim).toContain('5.0.0')
    expect(first.value.candidates[0]?.fingerprint).toBe(reordered.value.candidates[0]?.fingerprint)
  })

  it('changes the proposal identity when a new version arrives', () => {
    const first = parseDependencyUpdates(answer([update]))
    const next = parseDependencyUpdates(answer([{ ...update, latest: '5.1.0' }]))
    if (first._tag !== 'Ok' || next._tag !== 'Ok')
      throw new Error('Expected dependency proposals.')
    expect(first.value.candidates[0]?.fingerprint).not.toBe(next.value.candidates[0]?.fingerprint)
  })

  it('excludes TypeScript 7 while retaining another major update', () => {
    const result = parseDependencyUpdates(answer([update, { ...update, name: 'typescript', current: '6.0.3', latest: '7.0.0' }]))
    if (result._tag !== 'Ok')
      throw new Error('Expected a dependency proposal.')
    expect(result.value.candidates).toHaveLength(1)
    expect(result.value.candidates[0]?.claim).not.toContain('7.0.0')
    expect(result.value.report).toContain('typescript 7.0.0')
  })

  it('permits TypeScript 6 updates', () => {
    const result = parseDependencyUpdates(answer([{ ...update, name: 'typescript', current: '6.0.3', latest: '6.0.4' }]))
    expect(result).toMatchObject({ _tag: 'Ok', value: { candidates: [{ claim: expect.stringContaining('6.0.4') }] } })
  })

  it.each([{ updates: [] }, { updates: [{ ...update, name: 'typescript', current: '6.0.3', latest: '7.0.0' }] }, { updates: [{ ...update, latest: update.current }] }])('creates no empty proposal for %j', ({ updates }) => {
    expect(parseDependencyUpdates(answer(updates))).toMatchObject({ _tag: 'Ok', value: { candidates: [] } })
  })

  it.each([null, {}, { report: '', updates: [] }, answer([{ ...update, manifest: '../package.json' }]), answer([{ ...update, latest: 'latest' }])])('rejects invalid scan data %j', (input) => {
    expect(parseDependencyUpdates(input)._tag).toBe('Err')
  })
})
