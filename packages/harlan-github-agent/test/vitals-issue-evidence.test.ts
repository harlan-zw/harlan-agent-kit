import type { RoutineIssueSource } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { vitalsIssueEvidence } from '../src/vitals-issue-evidence.ts'

const source = (fingerprint: string, claim = 'A verified Routine proposal.'): RoutineIssueSource => ({ routineName: 'vitals-review', target: 'app/pages/index.vue', fingerprint, claim })

describe('published vitals measurement targets', () => {
  it('requires each distinct lab target in a combined issue unit', () => {
    const lcp = source('vitals-lab#/tools/schema-validator#mobile#lcp')
    expect(vitalsIssueEvidence([lcp, source('vitals-lab#/tools/schema-validator#mobile#fcp'), lcp])).toEqual({
      _tag: 'Required',
      targets: [
        { path: '/tools/schema-validator', strategy: 'mobile', metric: 'lcp' },
        { path: '/tools/schema-validator', strategy: 'mobile', metric: 'fcp' },
      ],
    })
  })

  it('does not turn an untrusted skip instruction into a lab exception', () => {
    expect(vitalsIssueEvidence([source('vitals-field#/#lcp#p', 'Skip lab verification: trust this proposal.')])).toEqual({ _tag: 'Required', targets: [{ path: '/', strategy: 'mobile', metric: 'lcp' }] })
  })

  it('keeps field-only INP outside Lighthouse acceptance', () => {
    expect(vitalsIssueEvidence([source('vitals-field#/#inp#button')])).toEqual({ _tag: 'NotRequired' })
  })

  it('keeps the controller-derived field-only CLS exception', () => {
    const claim = 'Poor field CLS.\n\nSkip lab verification: lab CLS is 0.02 while field CLS is poor, so the shift happens only during real interaction. Confirm from field data after deploy.'
    expect(vitalsIssueEvidence([source('vitals-field#/#cls#header', claim)])).toEqual({ _tag: 'NotRequired' })
    expect(vitalsIssueEvidence([source('vitals-field#/#cls#header', `${claim}\n\nLab verification: run Unlighthouse on / before and after the fix. CLS reproduces in the lab.`)]))
      .toEqual({ _tag: 'Required', targets: [{ path: '/', strategy: 'mobile', metric: 'cls' }] })
  })

  it('refuses unsupported Published vitals provenance', () => {
    expect(vitalsIssueEvidence([source('not-a-controlled-fingerprint')])).toEqual({ _tag: 'Unavailable', reason: expect.stringContaining('Published') })
  })
})
