import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, expect, it } from 'vitest'
import { createReviewProofLauncher } from '../src/review-proof-process.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function run(source: string, timeoutMilliseconds = 1000) {
  const root = await mkdtemp(join(tmpdir(), 'review-proof-process-'))
  roots.push(root)
  const sourcePath = join(root, 'proof.ts')
  await writeFile(sourcePath, source)
  const nodeArguments = ['--experimental-strip-types', '--permission', `--allow-fs-read=${sourcePath}`, sourcePath]
  let released = false
  // This fixture checks Node restrictions. Production preparation must also supply the OS namespace.
  const launch = createReviewProofLauncher(async () => ({ binary: process.execPath, arguments: nodeArguments, environment: {}, release: async () => {
    released = true
  } }))
  const outcome = await launch({ workspace: root, sourcePath, nodeArguments, timeoutMilliseconds })
  expect(released).toBe(true)
  return outcome
}

it('denies child processes and filesystem writes under the fixed Node plan', async () => {
  const result = await run('import { execSync } from "node:child_process"; execSync("echo escaped")')
  expect(result._tag).toBe('Exited')
  if (result._tag === 'Exited') {
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('ERR_ACCESS_DENIED')
  }
  const write = await run('import { writeFileSync } from "node:fs"; writeFileSync("owned", "bad")')
  expect(write._tag).toBe('Exited')
  if (write._tag === 'Exited')
    expect(write.output).toContain('ERR_ACCESS_DENIED')
})

it('kills an infinite probe and retains bounded output', async () => {
  expect((await run('while (true) {}', 50))._tag).toBe('TimedOut')
  const result = await run('console.log("x".repeat(100_000)); process.exit(7)')
  expect(result._tag).toBe('Exited')
  if (result._tag === 'Exited') {
    expect(result.exitCode).toBe(7)
    expect(result.output.length).toBeLessThanOrEqual(12_000)
  }
})
