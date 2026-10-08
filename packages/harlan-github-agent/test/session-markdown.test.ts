import { describe, expect, it } from 'vitest'
import { sessionMarkdown, sessionSafeHref } from '../dashboard/app/utils/session-markdown.ts'

describe('agent Markdown', () => {
  it('preserves headings, strong text, lists, and fenced code as semantic content', () => {
    expect(sessionMarkdown('# Result\n\n**Passed** for `src/a.ts`.\n\n- First\n- Second\n\n```ts\nconst value = 1\n```')).toEqual([
      { kind: 'heading', level: 1, content: [{ kind: 'text', text: 'Result' }] },
      { kind: 'paragraph', content: [{ kind: 'strong', content: [{ kind: 'text', text: 'Passed' }] }, { kind: 'text', text: ' for ' }, { kind: 'code', text: 'src/a.ts' }, { kind: 'text', text: '.' }] },
      { kind: 'list', ordered: false, start: 1, items: [{ checked: null, blocks: [{ kind: 'paragraph', content: [{ kind: 'text', text: 'First' }] }] }, { checked: null, blocks: [{ kind: 'paragraph', content: [{ kind: 'text', text: 'Second' }] }] }] },
      { kind: 'code', language: 'ts', text: 'const value = 1' },
    ])
  })
  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '//evil.example', 'vbscript:alert(1)'])('refuses unsafe link %s', (href) => {
    expect(sessionSafeHref(href)).toBe(null)
  })
  it('keeps HTML as plain text and refuses active links', () => {
    const blocks = sessionMarkdown('<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))')
    expect(blocks).toEqual([
      { kind: 'paragraph', content: [{ kind: 'text', text: '<img src=x onerror=alert(1)>\n\n' }] },
      { kind: 'paragraph', content: [{ kind: 'link', href: null, content: [{ kind: 'text', text: 'bad' }] }] },
    ])
  })
  it('allows web and local relative links', () => {
    expect(sessionSafeHref('https://example.com/a')).toBe('https://example.com/a')
    expect(sessionSafeHref('/history')).toBe('/history')
    expect(sessionSafeHref('#result')).toBe('#result')
  })
})
