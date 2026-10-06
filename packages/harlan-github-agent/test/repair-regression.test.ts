import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { expect, it } from 'vitest'
import { confirmRepairRecoveryRegression } from '../src/worktree.ts'

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
    const result = await confirmRepairRecoveryRegression(path, ['selected.test.ts'], AbortSignal.timeout(20_000))
    expect(result._tag).toBe(mode === 'assertion' || mode === 'output' ? 'Ok' : 'Err')
  }
  finally {
    process.env.PATH = originalPath
    rmSync(path, { recursive: true, force: true })
  }
}, 30_000)
