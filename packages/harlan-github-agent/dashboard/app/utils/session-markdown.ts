import type { Token, Tokens } from 'marked'
import { lexer } from 'marked'

export type SessionInline
  = | { kind: 'text' | 'code', text: string }
    | { kind: 'strong' | 'emphasis' | 'strike', content: SessionInline[] }
    | { kind: 'link', href: string | null, content: SessionInline[] }
    | { kind: 'break' }

export type SessionMarkdownBlock
  = | { kind: 'paragraph', content: SessionInline[] }
    | { kind: 'heading', level: number, content: SessionInline[] }
    | { kind: 'code', language: string, text: string }
    | { kind: 'quote', blocks: SessionMarkdownBlock[] }
    | { kind: 'list', ordered: boolean, start: number, items: Array<{ checked: boolean | null, blocks: SessionMarkdownBlock[] }> }
    | { kind: 'table', header: SessionInline[][], rows: SessionInline[][][] }
    | { kind: 'rule' }

export function sessionSafeHref(href: string): string | null {
  const clean = href.trim()
  if (clean.startsWith('//') || [...clean].some(character => character.charCodeAt(0) <= 32 || character === '\\'))
    return null
  return /^https?:\/\//i.test(clean) || /^\/(?!\/)/.test(clean) || clean.startsWith('#') ? clean : null
}

function inline(tokens: Token[], depth: number): SessionInline[] {
  return tokens.flatMap((token): SessionInline[] => {
    if (depth > 24)
      return [{ kind: 'text', text: token.raw }]
    switch (token.type) {
      case 'strong': return [{ kind: 'strong', content: inline(token.tokens ?? [], depth + 1) }]
      case 'em': return [{ kind: 'emphasis', content: inline(token.tokens ?? [], depth + 1) }]
      case 'del': return [{ kind: 'strike', content: inline(token.tokens ?? [], depth + 1) }]
      case 'codespan': return [{ kind: 'code', text: token.text }]
      case 'link': return [{ kind: 'link', href: sessionSafeHref(token.href), content: inline(token.tokens ?? [], depth + 1) }]
      case 'image': return [{ kind: 'link', href: sessionSafeHref(token.href), content: [{ kind: 'text', text: token.text || 'Image' }] }]
      case 'br': return [{ kind: 'break' }]
      case 'html': return [{ kind: 'text', text: token.raw }]
      default: return 'tokens' in token && token.tokens ? inline(token.tokens, depth + 1) : [{ kind: 'text', text: 'text' in token ? token.text ?? token.raw : token.raw }]
    }
  })
}

function blocks(tokens: Token[], depth = 0): SessionMarkdownBlock[] {
  return tokens.flatMap((token): SessionMarkdownBlock[] => {
    if (depth > 24)
      return [{ kind: 'paragraph', content: [{ kind: 'text', text: token.raw }] }]
    switch (token.type) {
      case 'space': return []
      case 'heading': return [{ kind: 'heading', level: token.depth, content: inline(token.tokens ?? [], depth) }]
      case 'paragraph':
      case 'text': return [{ kind: 'paragraph', content: inline(token.tokens ?? [token], depth) }]
      case 'code': return [{ kind: 'code', language: (token.lang ?? '').split(/\s/)[0] ?? '', text: token.text }]
      case 'blockquote': return [{ kind: 'quote', blocks: blocks(token.tokens ?? [], depth + 1) }]
      case 'list': return [{ kind: 'list', ordered: token.ordered, start: typeof token.start === 'number' ? token.start : 1, items: token.items.map((item: Tokens.ListItem) => ({ checked: typeof item.checked === 'boolean' ? item.checked : null, blocks: blocks(item.tokens, depth + 1) })) }]
      case 'table': return [{ kind: 'table', header: token.header.map((cell: Tokens.TableCell) => inline(cell.tokens, depth)), rows: token.rows.map((row: Tokens.TableCell[]) => row.map(cell => inline(cell.tokens, depth))) }]
      case 'hr': return [{ kind: 'rule' }]
      default: return [{ kind: 'paragraph', content: [{ kind: 'text', text: token.raw }] }]
    }
  })
}

/** Render a parser-owned tree as Vue text and semantic elements. Raw HTML never becomes DOM. */
export function sessionMarkdown(text: string): SessionMarkdownBlock[] {
  return blocks(lexer(text, { gfm: true }))
}
