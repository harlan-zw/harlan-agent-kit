import type { Result } from '../../../src/result.ts'

export type TerminalDiffSource =
  | { _tag: 'Working' }
  | { _tag: 'Staged' }
  | { _tag: 'Comparison'; base: string; head: string }
export type TerminalDiffError = 'InvalidRequest' | 'Unavailable' | 'TooLarge' | 'Binary' | 'Symlink' | 'Changed'
export interface TerminalDiffInventory {
  id: string
  base: string
  source: TerminalDiffSource
  files: { path: string; status: string }[]
}
export interface TerminalDiffContent {
  path: string
  generation: string
  oldText: string
  newText: string
}
export type TerminalDiffResult<T> = Result<T, TerminalDiffError>
// Pierre 1.2 forwards these options to diff 8.0.3. The runtime contract has a focused test.
export const terminalDiffParseOptions = { context: 3, timeout: 250, maxEditLength: 10_000 }
const invalid = (): TerminalDiffResult<never> => ({ _tag: 'Err', error: 'InvalidRequest' })
const tooLarge = (): TerminalDiffResult<never> => ({ _tag: 'Err', error: 'TooLarge' })
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
}
function sha(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value)
}
function generation(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{64}$/i.test(value)
}
function failure(value: Record<string, unknown>): TerminalDiffResult<never> | undefined {
  if (value._tag !== 'Err') return undefined
  const choices: readonly string[] = ['InvalidRequest', 'Unavailable', 'TooLarge', 'Binary', 'Symlink', 'Changed']
  return typeof value.error === 'string' && choices.includes(value.error)
    ? { _tag: 'Err', error: value.error as TerminalDiffError }
    : invalid()
}
function parseInventory(input: unknown, maximum: number): TerminalDiffResult<TerminalDiffInventory> {
  if (!record(input)) return invalid()
  const error = failure(input)
  if (error) return error
  if (input._tag !== 'Ok' || !record(input.value)) return invalid()
  const value = input.value
  if (!generation(value.id) || !sha(value.base) || !record(value.source) || !Array.isArray(value.files))
    return invalid()
  if (value.files.length > maximum) return tooLarge()
  let source: TerminalDiffSource
  if (value.source._tag === 'Working' || value.source._tag === 'Staged') source = { _tag: value.source._tag }
  else if (value.source._tag === 'Comparison' && sha(value.source.base) && sha(value.source.head))
    source = { _tag: 'Comparison', base: value.source.base, head: value.source.head }
  else return invalid()
  const files: TerminalDiffInventory['files'] = []
  const paths = new Set<string>()
  let metadataBytes = 0
  for (const item of value.files) {
    if (!record(item) || !text(item.path, 4096) || !text(item.status, 3) || paths.has(item.path)) return invalid()
    metadataBytes += new TextEncoder().encode(item.path).byteLength
    if (metadataBytes > 1024 * 1024) return tooLarge()
    paths.add(item.path)
    files.push({ path: item.path, status: item.status })
  }
  return { _tag: 'Ok', value: { id: value.id, base: value.base, source, files } }
}
export const parseTerminalDiffInventory = (input: unknown) => parseInventory(input, 500)
export type PullRequestDiffInventory = TerminalDiffInventory & {
  coverage: { _tag: 'Complete' } | { _tag: 'Incomplete'; reason: 'GitHubFileLimit' }
}
export function parsePullRequestDiffInventory(input: unknown): TerminalDiffResult<PullRequestDiffInventory> {
  const result = parseInventory(input, 3000)
  if (result._tag === 'Err') return result
  if (
    !record(input) ||
    !record(input.value) ||
    !record(input.value.coverage) ||
    result.value.source._tag !== 'Comparison'
  )
    return invalid()
  const coverage = input.value.coverage
  if (coverage._tag === 'Complete') return { _tag: 'Ok', value: { ...result.value, coverage: { _tag: 'Complete' } } }
  if (coverage._tag === 'Incomplete' && coverage.reason === 'GitHubFileLimit')
    return { _tag: 'Ok', value: { ...result.value, coverage: { _tag: 'Incomplete', reason: 'GitHubFileLimit' } } }
  return invalid()
}
export function parseTerminalDiffContent(
  input: unknown,
  expectedPath: string,
): TerminalDiffResult<TerminalDiffContent> {
  if (!record(input)) return invalid()
  const error = failure(input)
  if (error) return error
  if (input._tag !== 'Ok' || !record(input.value)) return invalid()
  const value = input.value
  if (
    !text(value.path, 4096) ||
    value.path !== expectedPath ||
    !generation(value.generation) ||
    typeof value.oldText !== 'string' ||
    typeof value.newText !== 'string' ||
    value.oldText.includes('\0') ||
    value.newText.includes('\0')
  ) {
    return invalid()
  }
  const max = 2 * 1024 * 1024
  if (
    value.oldText.length > max ||
    value.newText.length > max ||
    new TextEncoder().encode(value.oldText).byteLength > max ||
    new TextEncoder().encode(value.newText).byteLength > max
  ) {
    return tooLarge()
  }
  return {
    _tag: 'Ok',
    value: { path: value.path, generation: value.generation, oldText: value.oldText, newText: value.newText },
  }
}

/** Apply the smaller rendering limit before the main thread computes a diff. */
export function prepareTerminalDiffContent(value: TerminalDiffContent): TerminalDiffResult<TerminalDiffContent> {
  for (const text of [value.oldText, value.newText]) {
    if (text.length > 256 * 1024 || new TextEncoder().encode(text).byteLength > 256 * 1024) return tooLarge()
    let lines = 1
    for (let index = 0; index < text.length; index++) {
      if (text.charCodeAt(index) === 10 && ++lines > 10_000) return tooLarge()
    }
  }
  return { _tag: 'Ok', value }
}
