import { describe, expect, it } from 'vitest'
import { getRoutine } from '../src/routines/index.ts'

const routine = getRoutine('dependency-updates')
const parseDependencyUpdates = routine.parseResponse

const update = { manifest: 'pnpm-workspace.yaml', name: 'nuxt', current: '4.0.0', latest: '5.0.0' }
const answer = (updates: unknown[]) => ({ outcome: 'complete', report: 'Registry scan completed.', updates })

describe('dependency update proposals', () => {
  it('reports existing dependency work without claiming registry coverage or proposing duplicate work', () => {
    expect(parseDependencyUpdates({ outcome: 'existing_work', report: 'PR https://github.com/harlan-zw/example/pull/25 needs a rebase. Harlan owns it.', updates: [] }))
      .toEqual({
        _tag: 'Ok',
        value: {
          report: 'Dependency scan skipped because dependency work is open. Registry coverage is not established by this result.\n\nPR https://github.com/harlan-zw/example/pull/25 needs a rebase. Harlan owns it.',
          candidates: [],
        },
      })
  })

  it('rejects updates returned with existing dependency work', () => {
    expect(parseDependencyUpdates({ outcome: 'existing_work', report: 'PR #25 owns dependency work.', updates: [update] }))
      .toEqual({ _tag: 'Err', error: 'Existing dependency work must return an empty update list.' })
  })

  it('surfaces a failed registry read', () => {
    expect(parseDependencyUpdates({ outcome: 'blocked', report: 'Registry authentication failed.', updates: [] }))
      .toEqual({ _tag: 'Err', error: 'Dependency scan blocked: Registry authentication failed.' })
  })

  it('splits minor and patch updates from majors into two reproducible proposals with their own issues', () => {
    const updates = [
      update,
      { ...update, name: 'vue', current: '3.5.0', latest: '3.6.0' },
      { ...update, name: 'obuild', current: '0.4.44', latest: '0.5.0' },
      { ...update, name: '@nuxt/devtools', current: '4.0.0-beta.4', latest: '4.0.0-beta.5' },
    ]
    const first = parseDependencyUpdates(answer(updates))
    const reordered = parseDependencyUpdates(answer([...updates].reverse()))
    if (first._tag !== 'Ok' || reordered._tag !== 'Ok')
      throw new Error('Expected dependency proposals.')
    const [minorAndPatch, major] = first.value.candidates

    expect(first.value.candidates).toHaveLength(2)
    expect(minorAndPatch?.claim).toContain('3.6.0')
    expect(minorAndPatch?.claim).not.toMatch(/5\.0\.0|0\.5\.0|beta\.5/)
    for (const latest of ['5.0.0', '0.5.0', '4.0.0-beta.5'])
      expect(major?.claim).toContain(latest)
    expect(major?.claim).not.toContain('3.6.0')
    expect(reordered.value.candidates.map(candidate => candidate.fingerprint)).toEqual(first.value.candidates.map(candidate => candidate.fingerprint))
    expect(routine.issueFingerprint(minorAndPatch!.fingerprint)).not.toBe(routine.issueFingerprint(major!.fingerprint))
  })

  it.each([
    ['only minor and patch updates', { ...update, current: '4.0.0', latest: '4.1.0' }, 'package.json#minor-and-patch'],
    ['only majors', update, 'package.json'],
  ])('files one proposal for %s', (_case, value, target) => {
    expect(parseDependencyUpdates(answer([value]))).toMatchObject({ _tag: 'Ok', value: { candidates: [{ target }] } })
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
