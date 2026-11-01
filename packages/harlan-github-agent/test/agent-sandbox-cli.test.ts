import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it.each(['public', 'symlink', 'directory', 'oversized', 'malformed', 'binary', 'argument'])('rejects a %s launch plan before executing the child', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-launch-'))
  const adapter = join(root, 'adapter.ts')
  const plan = `${adapter}.json`
  const valid = JSON.stringify({ binary: '/usr/bin/bwrap', args: ['--version'] })
  try {
    await copyFile(fileURLToPath(new URL('../src/agent-sandbox-cli.ts', import.meta.url)), adapter)
    if (kind === 'symlink') {
      await writeFile(join(root, 'target'), valid, { mode: 0o600 })
      await symlink(join(root, 'target'), plan)
    }
    else if (kind === 'directory') {
      await mkdir(plan, { mode: 0o700 })
    }
    else {
      const content = kind === 'oversized'
        ? ' '.repeat(1024 * 1024 + 1)
        : kind === 'malformed'
          ? '{'
          : kind === 'binary'
            ? JSON.stringify({ binary: '/bin/sh', args: ['-c', 'echo unsafe'] })
            : kind === 'argument' ? JSON.stringify({ binary: '/usr/bin/bwrap', args: [null] }) : valid
      await writeFile(plan, content, { mode: 0o600 })
      if (kind === 'public')
        await chmod(plan, 0o644)
    }
    const outcome = await execute(process.execPath, [adapter], { env: { HARLAN_AGENT_SANDBOX_ENV: '{}' } })
      .then(result => ({ _tag: 'Executed' as const, ...result }))
      .catch((error: { code: number, stdout: string }) => ({ _tag: 'Rejected' as const, code: error.code, stdout: error.stdout }))
    expect(outcome).toEqual({ _tag: 'Rejected', code: 1, stdout: '' })
  }
  finally {
    await rm(root, { recursive: true })
  }
})
