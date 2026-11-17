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
      listImplicitSignals: () => {
        reads.push(0)
        return []
      },
    })
    expect(result._tag).toBe('Err')
    expect(reads).toEqual([])
  })

  it('skips Agent feedback scans only when neither Agent feedback nor an Implicit signal exists', () => {
    const reads: unknown[] = []
    const result = getRoutine('agent-feedback').prepare('harlan-zw/harlan-agent-kit', {
      listAgentFeedback: (limit) => {
        reads.push(limit)
        return []
      },
      listImplicitSignals: (input) => {
        reads.push(input)
        return []
      },
    })
    expect(result).toMatchObject({ _tag: 'Ok', value: { _tag: 'Skip', evidence: expect.stringContaining('0 signals') } })
    expect(reads).toEqual([
      10,
      { kinds: ['HumanCommit', 'ClosedUnmerged'], limitPerKind: 5, origin: 'ServiceOpened' },
      { kinds: ['LoggedFindingPickedUp'], limitPerKind: 5, origin: 'Any' },
    ])
  })

  it('runs on Implicit signals alone and keeps them apart from Agent feedback', () => {
    const signal = {
      _tag: 'ClosedUnmerged' as const,
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      title: 'Fix the parser',
      headSha: 'abc123',
      occurredAt: '2026-11-18T00:00:00.000Z',
      openedBy: 'issue_work' as const,
      reviewRun: null,
    }
    const definition = getRoutine('agent-feedback')
    const result = definition.prepare('harlan-zw/harlan-agent-kit', { listAgentFeedback: () => [], listImplicitSignals: input => input.origin === 'ServiceOpened' ? [signal] : [] })
    expect(result).toEqual({ _tag: 'Ok', value: { _tag: 'Run', feedback: [], signals: [signal] } })

    const prompt = definition.scanPrompt({ name: 'agent-feedback', repository: 'harlan-zw/harlan-agent-kit', mode: 'propose', priorCandidates: [], feedback: [], signals: [signal] })
    expect(prompt).toContain('never Agent feedback')
    expect(prompt).toContain(JSON.stringify([signal]))
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

  it('requires the repaired skill and its bounded replay before commit', () => {
    const target = 'harlan-agent-kit/skills/pr/SKILL.md'
    const definition = getRoutine('agent-feedback')
    const replay = ['harlan-agent-kit/evals/feedback-pr/prompt.md', 'harlan-agent-kit/evals/feedback-pr/graders/criteria.md']
    expect(definition.issueWork.verifyChanges(target, [target, ...replay])).toEqual({ _tag: 'Ok', value: undefined })
    expect(definition.issueWork.verifyChanges(target, [target])._tag).toBe('Err')
    expect(definition.issueWork.verifyChanges(target, [target, replay[0]!])._tag).toBe('Err')
    expect(definition.issueWork.verifyChanges(target, [target, replay[0]!, replay[0]!])._tag).toBe('Err')
    expect(definition.issueWork.verifyChanges(target, [target, ...replay, 'src/other.ts'])._tag).toBe('Err')
    expect(definition.issueWork.verifyChanges(target, [target, 'harlan-agent-kit/evals/feedback-other/prompt.md', replay[1]!])._tag).toBe('Err')
    expect(definition.issueWork.verifyChanges(target, [target, 'src/other.ts'])._tag).toBe('Err')
    expect(definition.issueWork.verifyChanges(target, ['src/other.ts'])._tag).toBe('Err')
  })

  it('selects one precise skill repair with its replay files', () => {
    const target = 'harlan-agent-kit/skills/pr/SKILL.md'
    expect(getRoutine('agent-feedback').selectCandidates([
      { ...candidate, target, estimatedChangedFiles: 1 },
      { ...candidate, target, estimatedChangedFiles: 4 },
      { ...candidate, target: 'src/controller.ts', estimatedChangedFiles: 3 },
      { ...candidate, target, estimatedChangedFiles: 3 },
      { ...candidate, target: 'harlan-agent-kit/skills/other/SKILL.md', estimatedChangedFiles: 3 },
    ])).toEqual([{ ...candidate, target, estimatedChangedFiles: 3 }])
  })

  it('gives dependency version sets one open issue identity', () => {
    expect(getRoutine('dependency-updates').issueFingerprint('dependency-updates:version-a')).toBe('dependency-updates')
    expect(getRoutine('dependency-updates').issueFingerprint('dependency-updates:version-b')).toBe('dependency-updates')
    expect(getRoutine('pr-triage').issueFingerprint('src/one.ts')).toBe('src/one.ts')
  })
})

describe('cI review reports', () => {
  it('groups maintenance before filing and preserves urgent repairs', () => {
    const result = getRoutine('ci-review').parseResponse({ report: 'Three proven findings.', candidates: [
      { ...candidate, urgency: 'maintenance' },
      { ...candidate, fingerprint: 'two', urgency: 'maintenance' },
      { ...candidate, fingerprint: 'outage', urgency: 'urgent' },
    ] })
    expect(result).toMatchObject({ _tag: 'Ok', value: { candidates: [
      { fingerprint: 'outage' },
      { claim: expect.stringContaining('one'), estimatedChangedFiles: 2 },
    ] } })
    if (result._tag === 'Ok')
      expect(result.value.candidates).toHaveLength(2)
  })
  it.each([undefined, '', '  '])('requires evidence even with no findings: %s', (report) => {
    expect(getRoutine('ci-review').parseResponse({ report, candidates: [] }))
      .toEqual({ _tag: 'Err', error: 'The CI review Routine answered without its report.' })
  })

  it('keeps unavailable logs visible without inventing a repair', () => {
    expect(getRoutine('ci-review').parseResponse({ report: 'Incomplete: logs expired for run 42.', candidates: [] }))
      .toEqual({ _tag: 'Ok', value: { report: 'Incomplete: logs expired for run 42.', candidates: [] } })
  })
})

describe('candidate fingerprint canonicalisation', () => {
  const parse = (fingerprint: string): string => {
    const result = getRoutine('pr-triage').parseResponse({ candidates: [{ ...candidate, fingerprint }] })
    if (result._tag === 'Err')
      throw new Error(result.error)
    return result.value.candidates[0]!.fingerprint
  }

  // The six scripts.nuxt.com Candidates that opened four pull requests for one
  // Sentry event. Three distinct defects, six spellings.
  it.each([
    ['nuxt.config.ts:nuxtSentry.policy.ignoreErrors', 'nuxt.config.ts#nuxtSentry.policy.ignoreErrors'],
    ['nuxt.config.ts#nuxtSentry.policy.ignoreErrors', 'nuxt.config.ts#nuxtSentry.policy.ignoreErrors'],
    ['nuxt.config.ts#nuxtSentry.policy.dropStacklessErrors', 'nuxt.config.ts#nuxtSentry.policy.dropStacklessErrors'],
    ['nuxt.config.ts:nuxtSentry.policy.dropStacklessErrors', 'nuxt.config.ts#nuxtSentry.policy.dropStacklessErrors'],
  ])('reads %s as %s', (spelling, canonical) => {
    expect(parse(spelling)).toBe(canonical)
  })

  it('collapses the six real spellings to three identities', () => {
    const seen = new Set([
      'nuxt.config.ts:nuxtSentry.policy.ignoreErrors',
      'nuxt.config.ts#nuxtSentry.policy.ignoreErrors',
      'nuxt.config.ts#nuxtSentry.policy.ignoreErrors#receiving-end-does-not-exist',
      'nuxt.config.ts#nuxtSentry.policy.dropStacklessErrors',
      'nuxt.config.ts:nuxtSentry.policy.dropStacklessErrors',
      'nuxt.config.ts:nuxtSentry.policy.ignoreErrors',
    ].map(parse))
    expect(seen.size).toBe(3)
  })

  it.each([
    ['  src/one.ts#probe  ', 'src/one.ts#probe'],
    ['src/one.ts::probe', 'src/one.ts#probe'],
    ['src/one.ts#', 'src/one.ts'],
    ['src/one.ts  #  probe', 'src/one.ts#probe'],
  ])('trims and collapses %s to %s', (spelling, canonical) => {
    expect(parse(spelling)).toBe(canonical)
  })

  it('keeps two genuinely different symbols in one file apart', () => {
    expect(parse('src/one.ts#alpha')).not.toBe(parse('src/one.ts#beta'))
  })

  it('leaves case alone, so the ledger stays readable', () => {
    expect(parse('src/store.ts:openRoutineRun')).toBe('src/store.ts#openRoutineRun')
  })

  it('refuses a fingerprint that canonicalises to nothing', () => {
    expect(getRoutine('pr-triage').parseResponse({ candidates: [{ ...candidate, fingerprint: ' ## ' }] })._tag).toBe('Err')
  })
})
