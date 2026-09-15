import { describe, expect, it } from 'vitest'
import { getRoutine } from '../src/routines/index.ts'

const candidate = { fingerprint: 'one', title: 'Fix one', target: 'src/one.ts', claim: 'One defect.', verification: 'check', estimatedChangedFiles: 1 }

describe('built-in Routine contracts', () => {
  it('rejects foreign Agent feedback scans before reading evidence', () => {
    const reads: number[] = []
    const result = getRoutine('agent-feedback').prepare('harlan-zw/other', {
      listAgentFeedback: (limit) => {
        reads.push(limit)
        return []
      },
    })
    expect(result._tag).toBe('Err')
    expect(reads).toEqual([])
  })

  it('skips empty Agent feedback scans after reading the latest ten signals', () => {
    const reads: number[] = []
    const result = getRoutine('agent-feedback').prepare('harlan-zw/harlan-agent-kit', {
      listAgentFeedback: (limit) => {
        reads.push(limit)
        return []
      },
    })
    expect(result).toMatchObject({ _tag: 'Ok', value: { _tag: 'Skip', evidence: expect.stringContaining('0 signals') } })
    expect(reads).toEqual([10])
  })

  it('requires the Sentry report even with no code proposals', () => {
    expect(getRoutine('sentry-checkin').parseResponse({ candidates: [] }))
      .toEqual({ _tag: 'Err', error: 'The Sentry Routine answered without its issue report.' })
  })

  it('rejects malformed candidates before the ledger sees them', () => {
    expect(getRoutine('pr-triage').parseResponse({ candidates: [{ ...candidate, estimatedChangedFiles: -1 }] })._tag).toBe('Err')
    expect(getRoutine('pr-triage').parseResponse(null)._tag).toBe('Err')
  })

  it('uses the claim when a Candidate title is unusable', () => {
    expect(getRoutine('pr-triage').parseResponse({ candidates: [{ ...candidate, title: 42 }] }))
      .toMatchObject({ _tag: 'Ok', value: { candidates: [{ title: candidate.claim }] } })
  })

  it('enforces Agent feedback paths before commit', () => {
    const target = 'harlan-agent-kit/skills/pr/SKILL.md'
    const definition = getRoutine('agent-feedback')
    expect(definition.issueWork.verifyChanges(target, [target])).toEqual({ _tag: 'Ok', value: undefined })
    expect(definition.issueWork.verifyChanges(target, [target, 'src/other.ts'])._tag).toBe('Err')
    expect(definition.issueWork.verifyChanges(target, ['src/other.ts'])._tag).toBe('Err')
  })

  it('gives dependency version sets one open issue identity', () => {
    expect(getRoutine('dependency-updates').issueFingerprint('dependency-updates:version-a')).toBe('dependency-updates')
    expect(getRoutine('dependency-updates').issueFingerprint('dependency-updates:version-b')).toBe('dependency-updates')
    expect(getRoutine('pr-triage').issueFingerprint('src/one.ts')).toBe('src/one.ts')
  })
})

describe('cI review reports', () => {
  it.each([undefined, '', '  '])('requires evidence even with no findings: %s', (report) => {
    expect(getRoutine('ci-review').parseResponse({ report, candidates: [] }))
      .toEqual({ _tag: 'Err', error: 'The CI review Routine answered without its report.' })
  })

  it('keeps unavailable logs visible without inventing a repair', () => {
    expect(getRoutine('ci-review').parseResponse({ report: 'Incomplete: logs expired for run 42.', candidates: [] }))
      .toEqual({ _tag: 'Ok', value: { report: 'Incomplete: logs expired for run 42.', candidates: [] } })
  })
})
