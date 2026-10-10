import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it.each([
  ['lint', 0],
  ['lint', 7],
  ['typecheck', 0],
  ['typecheck', 7],
  ['test', 0],
  ['test', 7],
] as const)('runs the declared %s script and preserves its failure (%s)', async (name, exitCode) => {
  const root = await mkdtemp(join(tmpdir(), 'check-script-'))
  try {
    const binaries = join(root, 'node_modules/.bin')
    await mkdir(binaries, { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { [name]: 'repository-check' } }))
    await writeFile(join(root, 'vitest.config.ts'), 'export default {}')
    const tool = name === 'test' ? 'vitest' : name === 'lint' ? 'eslint' : 'vue-tsc'
    await writeFile(join(binaries, tool), '#!/bin/sh\nexit 99\n')
    await chmod(join(binaries, tool), 0o755)
    await writeFile(join(binaries, 'pnpm'), `#!/bin/sh\nprintf '%s' "$*" > invoked\nprintf '%s' "$CI" > ci\nexit ${exitCode}\n`)
    await chmod(join(binaries, 'pnpm'), 0o755)
    const result = await execute('bash', [resolve(import.meta.dirname, '../../../bin/check')], {
      cwd: root,
      env: { ...process.env, CI: 'false', CHECK_SKIP: '', PATH: `${binaries}:${process.env.PATH}` },
    }).then(() => 0).catch((error: { code: number }) => error.code)
    expect(result).toBe(exitCode === 0 ? 0 : 1)
    expect(await readFile(join(root, 'invoked'), 'utf8')).toBe(name)
    if (name === 'test')
      expect(await readFile(join(root, 'ci'), 'utf8')).toBe('true')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
