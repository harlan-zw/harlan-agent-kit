import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { confirmRepairRecoveryRegression } from '../src/worktree.ts'

it.each(['assertion', 'import', 'setup', 'runtime', 'passed'])('accepts only current assertion evidence: %s', async (mode) => {
  const path = mkdtempSync(join(tmpdir(), 'repair-regression-'))
  try {
    symlinkSync(resolve(import.meta.dirname, '../../../node_modules'), join(path, 'node_modules'))
    writeFileSync(join(path, 'package.json'), '{"name":"regression-fixture","type":"module","private":true}')
    writeFileSync(join(path, 'vitest.config.ts'), 'export default { test: { include: [\'*.test.ts\'] } }\n')
    const source = mode === 'assertion'
      ? 'it(\'keeps input\', () => expect(1).toBe(2))'
      : mode === 'import'
        ? 'import \'./missing.ts\'; it(\'keeps input\', () => expect(1).toBe(2))'
        : mode === 'setup'
          ? 'beforeEach(() => expect(1).toBe(2)); it(\'keeps input\', () => expect(1).toBe(1))'
          : mode === 'runtime'
            ? 'it(\'keeps input\', () => { throw new TypeError(\'missing helper\') })'
            : 'it(\'keeps input\', () => expect(1).toBe(1))'
    writeFileSync(join(path, 'selected.test.ts'), `import { it, expect, beforeEach } from 'vitest'\n${source}\n`)
    const result = await confirmRepairRecoveryRegression(path, ['selected.test.ts'], AbortSignal.timeout(20_000))
    expect(result._tag).toBe(mode === 'assertion' ? 'Ok' : 'Err')
  }
  finally {
    rmSync(path, { recursive: true, force: true })
  }
}, 30_000)
