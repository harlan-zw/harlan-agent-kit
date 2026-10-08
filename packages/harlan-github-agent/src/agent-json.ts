import type { Result } from './result.ts'
import { err, ok } from './result.ts'

/** Parse JSON without silently replacing a repeated object key. */
export function parseAgentJson(text: string): Result<unknown, 'malformed' | 'duplicate-key'> {
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch {
    return err('malformed')
  }
  const stack: Array<{ keys: Set<string>, keyExpected: boolean } | null> = []
  // JSON already parsed. Quoted tokens include escaped quotes and exclude punctuation inside strings.
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],:]/g)) {
    const token = match[0]
    if (token === '{') {
      stack.push({ keys: new Set(), keyExpected: true })
    }
    else if (token === '[') {
      stack.push(null)
    }
    else if (token === '}' || token === ']') {
      stack.pop()
    }
    else {
      const object = stack.at(-1)
      if (object === undefined || object === null)
        continue
      if (token === ',') {
        object.keyExpected = true
      }
      else if (token.startsWith('"') && object.keyExpected) {
        const key = JSON.parse(token) as string
        if (object.keys.has(key))
          return err('duplicate-key')
        object.keys.add(key)
        object.keyExpected = false
      }
    }
  }
  return ok(value)
}
