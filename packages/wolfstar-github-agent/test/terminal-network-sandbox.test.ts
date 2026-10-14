import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { prepareTerminalSandbox } from '../src/terminal-sandbox.ts'

const execute = promisify(execFile)
it('hides daemon control state while preserving provider authentication', async () => {
  const home = await mkdtemp(join(homedir(), 'scratch', 'terminal-daemon-mask-'))
  await mkdir(join(home, '.codex/app-server-daemon'), { recursive: true })
  await writeFile(join(home, '.codex/app-server-daemon/daemon-updater.sock'), 'control')
  await writeFile(join(home, '.codex/auth.json'), 'fixture authentication')
  const sandbox = await prepareTerminalSandbox({
    cwd: home,
    home,
    executable: '/usr/bin/sh',
    argv: [
      '-c',
      'test ! -e "$1/.codex/app-server-daemon/daemon-updater.sock" && cat "$1/.codex/auth.json"',
      'proof',
      home,
    ],
    environment: process.env,
  })
  const result = await execute(sandbox.executable, sandbox.argv, { env: sandbox.environment })
  expect(result.stdout).toBe('fixture authentication')
  await rm(home, { recursive: true })
})
it('preserves resolver content while hiding the user manager bus', async () => {
  const sandbox = await prepareTerminalSandbox({
    cwd: homedir(),
    executable: '/usr/bin/cat',
    argv: ['/etc/resolv.conf'],
    environment: process.env,
  })
  const result = await execute(sandbox.executable, sandbox.argv, { env: sandbox.environment })
  expect(result.stdout).toBe(await readFile('/etc/resolv.conf', 'utf8'))
  const denied = await prepareTerminalSandbox({
    cwd: homedir(),
    executable: '/usr/bin/test',
    argv: ['!', '-e', `/run/user/${process.getuid!()}/bus`],
    environment: process.env,
  })
  await expect(execute(denied.executable, denied.argv, { env: denied.environment })).resolves.toMatchObject({
    stdout: '',
  })
})
