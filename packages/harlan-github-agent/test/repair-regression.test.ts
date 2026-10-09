import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { expect, it } from 'vitest'
import { confirmRepairRecoveryRegression, runRepairRecoveryChecks } from '../src/worktree.ts'

it('rejects the worktree root as a selected test before running commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repair-empty-path-'))
  let ran = false
  try {
    const result = await confirmRepairRecoveryRegression(root, [''], AbortSignal.timeout(5_000), async () => {
      ran = true
      return { exitCode: 0 }
    })
    expect(result._tag).toBe('Err')
    expect(ran).toBe(false)
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(['file', 'manifest'])('rejects an external %s alias before running repository commands', async (mode) => {
  const root = mkdtempSync(join(tmpdir(), 'repair-test-boundary-'))
  const workspace = join(root, 'worktree')
  let ran = false
  try {
    mkdirSync(workspace)
    writeFileSync(join(root, 'outside.ts'), 'export {}')
    writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"vitest"}}')
    if (mode === 'file') {
      symlinkSync(join(root, 'outside.ts'), join(workspace, 'selected.test.ts'))
    }
    else {
      writeFileSync(join(workspace, 'selected.test.ts'), 'export {}')
      symlinkSync(join(root, 'package.json'), join(workspace, 'package.json'))
    }
    const result = await confirmRepairRecoveryRegression(workspace, ['selected.test.ts'], AbortSignal.timeout(5_000), async () => {
      ran = true
      return { exitCode: 0 }
    })
    expect(result._tag).toBe('Err')
    expect(ran).toBe(false)
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(['package', 'repository'])('uses the %s test script before checking current regression evidence', async (scope) => {
  const root = mkdtempSync(join(tmpdir(), 'repair-script-'))
  const directory = scope === 'package' ? join(root, 'packages/query') : root
  const selected = join(directory, 'selected.test.ts')
  const run = (input: { command: string, args: string[], workspace: string, signal: AbortSignal }) => new Promise<{ exitCode: number }>((resolve, reject) => {
    if (input.command === 'check' || input.args[0] === 'install') {
      resolve({ exitCode: 0 })
      return
    }
    execFile(input.command, input.args, { cwd: input.workspace, signal: input.signal }, error => error !== null && typeof error.code !== 'number'
      ? reject(error)
      : resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0 }))
  })
  try {
    mkdirSync(directory, { recursive: true })
    symlinkSync(resolve(import.meta.dirname, '../../../node_modules'), join(root, 'node_modules'))
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'verifyDepsBeforeRun: false\n')
    writeFileSync(join(root, 'package.json'), '{"name":"repository","type":"module","private":true}')
    if (scope === 'package')
      writeFileSync(join(root, 'vitest.config.ts'), 'export default { test: { include: ["*.test.ts"] } }')
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: scope, type: 'module', private: true, scripts: {
      [scope === 'package' ? 'test' : 'test:run']: 'node prepare.ts && vitest',
      ...(scope === 'package' ? { 'dev:prepare': 'node module-prepare.ts' } : {}),
    } }))
    if (scope === 'package') {
      writeFileSync(join(directory, 'module-prepare.ts'), 'import { writeFileSync } from "node:fs"; writeFileSync("module.ts", "export const input = 1")')
      writeFileSync(join(directory, 'prepare.ts'), 'import { input } from "./module.ts"; import { writeFileSync } from "node:fs"; writeFileSync("generated.ts", "export const input = " + input)')
    }
    else {
      writeFileSync(join(directory, 'prepare.ts'), 'import { writeFileSync } from "node:fs"; writeFileSync("generated.ts", "export const input = 1")')
    }
    writeFileSync(join(directory, 'vitest.config.ts'), 'export default { test: { include: ["*.test.ts"] } }')
    writeFileSync(selected, 'import { it, expect } from "vitest"; import { input } from "./generated.ts"; it("preserves input", () => expect(input).toBe(2))')
    const paths = [relative(root, selected)]
    expect(await confirmRepairRecoveryRegression(root, paths, AbortSignal.timeout(20_000), run)).toEqual({ _tag: 'Ok', value: undefined })
    rmSync(join(directory, 'generated.ts'))
    if (scope === 'package')
      rmSync(join(directory, 'module.ts'))
    writeFileSync(selected, 'import { it, expect } from "vitest"; import { input } from "./generated.ts"; it("preserves input", () => expect(input).toBe(1))')
    const green = await runRepairRecoveryChecks(root, paths, AbortSignal.timeout(20_000), run)
    expect(green._tag, JSON.stringify(green)).toBe('Ok')
    expect(existsSync(join(directory, 'generated.ts'))).toBe(true)
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 45_000)

it('runs regression evidence without exposing the controller code tree to the worker', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'repair-reporter-boundary-'))
  const serviceRoot = resolve(import.meta.dirname, '..')
  const exposed: string[] = []
  try {
    symlinkSync(resolve(import.meta.dirname, '../../../node_modules'), join(workspace, 'node_modules'))
    writeFileSync(join(workspace, 'package.json'), '{"name":"reporter-boundary","type":"module","private":true}')
    writeFileSync(join(workspace, 'pnpm-workspace.yaml'), 'verifyDepsBeforeRun: false\n')
    writeFileSync(join(workspace, 'vitest.config.ts'), 'export default { test: { include: [\'*.test.ts\'] } }\n')
    writeFileSync(join(workspace, 'selected.test.ts'), 'import { it, expect } from \'vitest\'; it(\'preserves input\', () => expect(1).toBe(2))\n')
    const result = await confirmRepairRecoveryRegression(workspace, ['selected.test.ts'], AbortSignal.timeout(20_000), input => new Promise((resolve, reject) => {
      for (const mount of input.readOnlyPaths ?? []) {
        exposed.push(mount)
        if (!relative(serviceRoot, mount).startsWith('..')) {
          reject(new Error('The worker cannot mount the controller code tree.'))
          return
        }
        if (input.writablePaths?.some(writable => !relative(writable, mount).startsWith('..'))) {
          reject(new Error('A writable mount hides the trusted reporter.'))
          return
        }
      }
      execFile(input.command, input.args, { cwd: input.workspace, signal: input.signal }, error => error !== null && typeof error.code !== 'number'
        ? reject(error)
        : resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0 }))
    }))
    expect(result).toEqual({ _tag: 'Ok', value: undefined })
    expect(exposed.every(path => !existsSync(path))).toBe(true)
  }
  finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}, 30_000)

it('refuses repository checks when worker isolation is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repair-missing-boundary-'))
  const originalHome = process.env.HOME
  const originalPath = process.env.PATH
  const marker = join(root, 'host-command-ran')
  try {
    mkdirSync(join(root, 'bin'))
    const binary = join(root, 'bin/pnpm')
    writeFileSync(binary, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`)
    chmodSync(binary, 0o700)
    process.env.HOME = root
    process.env.PATH = `${join(root, 'bin')}:${originalPath}`
    await expect(confirmRepairRecoveryRegression(root, ['selected.test.ts'], AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(() => execFileSync('test', ['-e', marker])).toThrow()
  }
  finally {
    process.env.HOME = originalHome
    process.env.PATH = originalPath
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(['assertion', 'output', 'import', 'setup', 'runtime', 'passed'])('accepts only current assertion evidence: %s', async (mode) => {
  const path = mkdtempSync(join(tmpdir(), 'repair-regression-'))
  const originalPath = process.env.PATH
  try {
    if (mode === 'output') {
      const pnpm = execFileSync('which', ['pnpm'], { encoding: 'utf8' }).trim()
      const bin = join(path, 'bin')
      mkdirSync(bin)
      const wrapper = join(bin, 'pnpm.ts')
      writeFileSync(wrapper, `#!/usr/bin/env -S node --experimental-strip-types\nimport { spawnSync } from 'node:child_process'\nimport process from 'node:process'\nprocess.stdout.write('Package manager diagnostic\\n')\nconst result = spawnSync(${JSON.stringify(pnpm)}, process.argv.slice(2), { stdio: 'inherit' })\nprocess.exit(result.status ?? 1)\n`)
      chmodSync(wrapper, 0o700)
      symlinkSync(wrapper, join(bin, 'pnpm'))
      process.env.PATH = `${bin}:${originalPath}`
    }
    symlinkSync(resolve(import.meta.dirname, '../../../node_modules'), join(path, 'node_modules'))
    writeFileSync(join(path, 'package.json'), '{"name":"regression-fixture","type":"module","private":true}')
    // This fixture borrows installed dependencies. It must not install into the external symlink.
    writeFileSync(join(path, 'pnpm-workspace.yaml'), 'verifyDepsBeforeRun: false\n')
    writeFileSync(join(path, 'vitest.config.ts'), 'export default { test: { include: [\'*.test.ts\'] } }\n')
    const source = mode === 'assertion' || mode === 'output'
      ? `it('keeps input', () => { ${mode === 'output' ? 'console.log("test diagnostic");' : ''} expect(1).toBe(2) })`
      : mode === 'import'
        ? 'import \'./missing.ts\'; it(\'keeps input\', () => expect(1).toBe(2))'
        : mode === 'setup'
          ? 'beforeEach(() => expect(1).toBe(2)); it(\'keeps input\', () => expect(1).toBe(1))'
          : mode === 'runtime'
            ? 'it(\'keeps input\', () => { throw new TypeError(\'missing helper\') })'
            : 'it(\'keeps input\', () => expect(1).toBe(1))'
    writeFileSync(join(path, 'selected.test.ts'), `import { it, expect, beforeEach } from 'vitest'\n${source}\n`)
    // These trusted reporter fixtures exercise classification. Boundary checks use the real sandbox separately.
    const result = await confirmRepairRecoveryRegression(path, ['selected.test.ts'], AbortSignal.timeout(20_000), input => new Promise((resolve, reject) => {
      execFile(input.command, input.args, { cwd: input.workspace, signal: input.signal }, (error) => {
        if (error !== null && typeof error.code !== 'number')
          reject(error)
        else
          resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0 })
      })
    }))
    if (mode === 'assertion' || mode === 'output') {
      expect(result._tag, JSON.stringify(result)).toBe('Ok')
    }
    else {
      expect(result).toEqual({
        _tag: 'Err',
        error: 'The selected regression tests must fail on the current base without setup errors.',
      })
    }
  }
  finally {
    process.env.PATH = originalPath
    rmSync(path, { recursive: true, force: true })
  }
}, 30_000)
