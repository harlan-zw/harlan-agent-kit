import type { GitHubAccount } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { githubAccountBody } from '../src/github-account.ts'
import { aboveFooter, automatedDisclosure, isCanonicalFooter } from '../src/review-comment.ts'

const kit = '[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit)'
const policy = '[AI policy](https://harlanzw.com/blog/ai-in-open-source)'

describe('automatedDisclosure', () => {
  it('names the bot, says it is not Harlan, and links the policy, whatever the comment is', () => {
    const kinds = ['review', 'repair', 'status', 'triage', 'release'] as const

    kinds.forEach((kind) => {
      expect(automatedDisclosure({ kind })).toBe(`<sub>${kit} automated ${kind}, not Harlan's · ${policy}</sub>`)
    })
  })

  it('says a person merges on a verdict, and lists the accepted commands in code spans', () => {
    expect(automatedDisclosure({ kind: 'review', merge: true, commands: ['Change', 'Rerun'] }))
      .toBe(`<sub>${kit} automated review, not Harlan's; a person merges · ${policy} · \`@harlan-agent rerun\` · \`@harlan-agent <change>\`</sub>`)
  })

  it('opens a settled state with a time that ages for the reader, and email keeps the clock time', () => {
    expect(automatedDisclosure({ kind: 'review', at: '2026-11-23T15:03:00.000Z' }))
      .toBe(`<sub><relative-time datetime="2026-11-23T15:03:00.000Z">2026-11-23 15:03 UTC</relative-time> · ${kit} automated review, not Harlan's · ${policy}</sub>`)
  })

  it('leaves out the time, so a working state that repeats itself writes nothing', () => {
    expect(automatedDisclosure({ kind: 'review' })).not.toContain('relative-time')
  })

  it('reads as one line that the comment readers know as its footer', () => {
    const line = automatedDisclosure({ kind: 'review', merge: true, at: '2026-11-23T15:03:00.000Z', commands: ['Rerun'] })
    expect(line.split('\n')).toHaveLength(1)
    expect(isCanonicalFooter(line)).toBe(true)
    expect(isCanonicalFooter('Comment `@harlan-agent rerun` to review this commit again.')).toBe(true)
    expect(isCanonicalFooter('<sub>1 note below 40/100 not shown.</sub>')).toBe(false)
  })

  it('puts a control above the footer, so the disclosure stays last', () => {
    const footer = automatedDisclosure({ kind: 'review' })
    expect(aboveFooter(`⚪ **Reviewing**\n\n${footer}`, '- [ ] Stop Review and any follow-up repair'))
      .toBe(`⚪ **Reviewing**\n\n- [ ] Stop Review and any follow-up repair\n\n${footer}`)
    expect(aboveFooter('A body without a footer', '- [ ] Control')).toBe('A body without a footer\n\n- [ ] Control')
  })
})

describe('a dedicated GitHub account', () => {
  const account: GitHubAccount = {
    login: 'im-brundlefly',
    tokenPath: '/private/brundlefly-token',
    name: 'Brundlefly',
    url: 'https://github.com/harlan-zw/brundlefly',
    instructions: 'Use short, clear sentences.',
  }

  it('names the account in the footer and drops "not Harlan\'s", with or without a time', () => {
    const body = `🟢 **Ready**\n\n${automatedDisclosure({ kind: 'review', merge: true, at: '2026-11-23T15:03:00.000Z', commands: ['Rerun'] })}`
    expect(githubAccountBody(body, account)).toBe(`🟢 **Ready**\n\n<sub><relative-time datetime="2026-11-23T15:03:00.000Z">2026-11-23 15:03 UTC</relative-time> · [Brundlefly](https://github.com/harlan-zw/brundlefly) automated review; a person merges · ${policy} · \`@harlan-agent rerun\`</sub>`)
    expect(githubAccountBody(automatedDisclosure({ kind: 'triage', disclaimer: 'not Harlan\'s commitment' }), account))
      .toBe(`<sub>[Brundlefly](https://github.com/harlan-zw/brundlefly) automated triage · ${policy}</sub>`)
  })

  it('leaves a footer inside a code block alone', () => {
    const quoted = `\`\`\`text\n${automatedDisclosure({ kind: 'review' })}\n\`\`\``
    expect(githubAccountBody(quoted, account)).toBe(quoted)
  })
})
