import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { expect, it } from 'vitest'

it('runs current regression evidence through the built package export', () => {
  const root = mkdtempSync(join(tmpdir(), 'repair-regression-built-'))
  const path = join(root, 'packages/harlan-github-agent')
  try {
    mkdirSync(path, { recursive: true })
    const source = resolve(import.meta.dirname, '..')
    mkdirSync(join(root, '.skills'))
    cpSync(resolve(source, '../../.skills/skilld.json'), join(root, '.skills/skilld.json'))
    cpSync(join(source, 'src'), join(path, 'src'), { recursive: true })
    for (const file of ['package.json', 'build.config.ts'])
      cpSync(join(source, file), join(path, file))
    symlinkSync(join(source, 'node_modules'), join(path, 'node_modules'))
    // Build the real package with already installed dependencies in this isolated fixture.
    writeFileSync(join(path, 'pnpm-workspace.yaml'), 'verifyDepsBeforeRun: false\n')
    execFileSync('pnpm', ['exec', 'obuild'], { cwd: path, stdio: 'pipe', timeout: 60_000 })
    const fixture = join(path, 'fixture')
    mkdirSync(fixture)
    symlinkSync(join(source, 'node_modules'), join(fixture, 'node_modules'))
    writeFileSync(join(fixture, 'package.json'), '{"name":"selected-regression","type":"module","private":true}')
    writeFileSync(join(fixture, 'pnpm-workspace.yaml'), 'verifyDepsBeforeRun: false\n')
    writeFileSync(join(fixture, 'vitest.config.ts'), 'export default { test: { include: [\'*.test.ts\'] } }\n')
    writeFileSync(join(path, 'verify.ts'), `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { confirmRepairRecoveryRegression } from 'harlan-github-agent'
import { execFile } from 'node:child_process'
const fixture = ${JSON.stringify(fixture)}
const results = []
for (const source of [
  "it('assertion', () => expect(1).toBe(2))",
  "import './missing.ts'; it('import', () => expect(1).toBe(2))",
  "beforeEach(() => expect(1).toBe(2)); it('setup', () => expect(1).toBe(1))",
  "it('runtime', () => { throw new TypeError('fixture runtime failure') })",
  "it('passed', () => expect(1).toBe(1))",
]) {
  writeFileSync(join(fixture, 'selected.test.ts'), "import { it, expect, beforeEach } from 'vitest'\\n" + source)
  results.push(await confirmRepairRecoveryRegression(fixture, ['selected.test.ts'], AbortSignal.timeout(20_000), input => new Promise((resolve, reject) => {
    execFile(input.command, input.args, { cwd: input.workspace, signal: input.signal }, error => {
      if (error !== null && typeof error.code !== 'number') reject(error)
      else resolve({ exitCode: error?.code ?? 0 })
    })
  })))
}
console.log(JSON.stringify(results))
`)
    const output = execFileSync(process.execPath, ['--experimental-strip-types', join(path, 'verify.ts')], {
      cwd: path,
      encoding: 'utf8',
      timeout: 110_000,
    })
    expect(JSON.parse(output)).toEqual([
      { _tag: 'Ok' },
      ...Array.from({ length: 4 }, () => ({
        _tag: 'Err',
        error: 'The selected regression tests must fail on the current base without setup errors.',
      })),
    ])
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
