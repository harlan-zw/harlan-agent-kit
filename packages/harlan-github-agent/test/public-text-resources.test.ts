import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { isPublishedForm } from '../src/public-text.ts'

function run(mode: string, first: number, second = 0) {
  const result = spawnSync(process.execPath, [
    '--max-old-space-size=192',
    fileURLToPath(new URL('./fixtures/public-text-resources.ts', import.meta.url)),
    mode,
    String(first),
    String(second),
  ], { encoding: 'utf8', timeout: 10_000 })
  expect(result.error, `Child failed: ${result.stderr}`).toBeUndefined()
  expect(result.status, `Child failed: ${result.stderr}`).toBe(0)
  return result.stdout
}

it('bounds allocations by matches plus source lines while removing the full span', () => {
  const measure = (matches: number, lines: number): { allocated: number, peakKiB: number } =>
    JSON.parse(run('allocation', matches, lines))
  const matchesOnly = measure(512, 16)
  const linesOnly = measure(16, 512)
  const both = measure(512, 512)

  expect(both.allocated).toBeLessThan(2 * (matchesOnly.allocated + linesOnly.allocated))
  expect(both.peakKiB).toBeLessThan(2 * Math.max(matchesOnly.peakKiB, linesOnly.peakKiB))
}, 40_000)

it.each(['withhold', 'receipt'])('bounds %s marker classification for mixed comment and text lines', (mode) => {
  for (const comments of [8, 32, 4096])
    expect(run(mode, comments)).toBe('ok')
}, 40_000)

it.each([
  [' \t<!-- first --><!-- second -->\r', true],
  ['<!-- outer <!-- inner -->', true],
  ['<!-- first --> text <!-- second -->', false],
  ['<!-- first --> trailing', false],
  ['leading <!-- first -->', false],
  ['<!-- first --><!-- unclosed', false],
  [' \t', false],
] as const)('classifies a marker line by its first comment closer: %j', (line, expected) => {
  const withheld = '_This text was withheld: it named a private path or host across lines._'
  expect(isPublishedForm(`${line}\n${withheld}`, `${line}\nsource`)).toBe(expected)
})
