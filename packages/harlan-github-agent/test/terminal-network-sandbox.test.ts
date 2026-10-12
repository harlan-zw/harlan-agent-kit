import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { prepareTerminalSandbox } from '../src/terminal-sandbox.ts'

const execute = promisify(execFile)
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
  await expect(execute(denied.executable, denied.argv, { env: denied.environment })).resolves.toMatchObject({ stdout: '' })
})
