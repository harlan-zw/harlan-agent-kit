import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createTerminalSystemdHost } from '../src/terminal-systemd.ts'

const execute = promisify(execFile)

it('starts helpers with launcher tools available when the user manager has a different PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-helper-path-'))
  try {
    const tools = join(root, 'tools')
    await mkdir(tools)
    await writeFile(join(tools, 'launcher-tool'), '#!/bin/sh\nprintf managed-tool', { mode: 0o700 })
    const result = join(root, 'result.json')
    const source = `import { execFileSync } from 'node:child_process'\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(result)}, execFileSync('launcher-tool', { encoding: 'utf8' }))\n`
    const digest = createHash('sha256').update(source).digest('hex')
    const directory = join(root, digest)
    await mkdir(directory)
    const entry = join(directory, 'helper.ts')
    const wasm = join(directory, 'engine.wasm')
    await writeFile(entry, source)
    await writeFile(wasm, 'fixture-engine')
    // This command boundary models the user manager's environment, not the launcher's environment.
    const managerRun = (async (_file: string, args: readonly string[]) => {
      const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }
      for (const argument of args) {
        if (argument.startsWith('--setenv=')) {
          const value = argument.slice('--setenv='.length)
          env[value.slice(0, value.indexOf('='))] = value.slice(value.indexOf('=') + 1)
        }
      }
      return execute(process.execPath, [entry], { env })
    }) as typeof execute
    const host = createTerminalSystemdHost(process.execPath, `${tools}:relative-tools:`, managerRun)
    await host.start({
      unit: 'wolfstar-terminal-000000000000000000000000.service',
      artifact: { entry, digest, wasm, wasmDigest: createHash('sha256').update('fixture-engine').digest('hex') },
      config: join(root, 'config.json'),
      reservationId: 'fixture-reservation',
      memoryGiB: 1,
    })
    expect(await readFile(result, 'utf8')).toBe('managed-tool')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
