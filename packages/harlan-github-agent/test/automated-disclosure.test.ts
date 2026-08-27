import { describe, expect, it } from 'vitest'
import { automatedDisclosure } from '../src/review-comment.ts'

describe('automatedDisclosure', () => {
  it('names the bot once and links the policy, whatever the comment is', () => {
    const kinds = ['review', 'repair update', 'status', 'triage'] as const

    kinds.forEach((kind) => {
      const line = automatedDisclosure({ kind })

      expect(line).toContain('[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) posted this automated')
      expect(line).toContain('[AI open source policy](https://harlanzw.com/blog/ai-in-open-source).')
      expect(line).toContain(`automated ${kind}.`)
    })
  })

  it('reads as one quoted line, so a comment never breaks its own blockquote', () => {
    const line = automatedDisclosure({
      kind: 'review',
      disclaimer: 'It is not Harlan\'s personal review or approval.',
      notes: ['A person still decides the merge.'],
      updatedAt: '2026-08-27 03:02 UTC',
    })

    expect(line.split('\n')).toHaveLength(1)
    expect(line.startsWith('> ')).toBe(true)
  })

  it('puts the disclaimer before the policy and the timestamp last', () => {
    const line = automatedDisclosure({
      kind: 'review',
      disclaimer: 'Disclaimed.',
      notes: ['Noted.'],
      updatedAt: '2026-08-27 03:02 UTC',
    })

    expect(line.indexOf('Disclaimed.')).toBeLessThan(line.indexOf('AI open source policy'))
    expect(line.indexOf('Noted.')).toBeLessThan(line.indexOf('Last updated'))
    expect(line.endsWith('Last updated: 2026-08-27 03:02 UTC.')).toBe(true)
  })

  it('leaves out the timestamp, so a comment that repeats itself writes nothing', () => {
    expect(automatedDisclosure({ kind: 'review' })).not.toContain('Last updated')
  })
})
