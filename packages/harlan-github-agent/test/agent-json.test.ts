import { expect, it } from 'vitest'
import { parseAgentJson } from '../src/agent-json.ts'
import { err, ok } from '../src/result.ts'

it.each([
  '{"checks":[],"checks":[]}',
  '{"checks":[],"\\u0063hecks":[]}',
  '{"nested":[{"checks":[],"checks":[]}]}',
])('rejects repeated keys in %s', (text) => {
  expect(parseAgentJson(text)).toEqual(err('duplicate-key'))
})

it('keeps sibling keys and quoted punctuation as ordinary JSON data', () => {
  const value = { checks: [{ name: 'first' }, { name: 'second' }], summary: '"checks":[] with \\ escapes and {braces}' }

  expect(parseAgentJson(JSON.stringify(value))).toEqual(ok(value))
})

it.each(['{"checks":', 'not JSON'])('rejects malformed JSON %s', (text) => {
  expect(parseAgentJson(text)).toEqual(err('malformed'))
})
