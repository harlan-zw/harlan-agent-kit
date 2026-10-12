import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createTerminalPreparationRunner, prepareTerminalSandbox } from '../src/terminal-sandbox.ts'

const execute = promisify(execFile)

it.each(['directory', 'symlink'] as const)('hides host SSH credentials from provider and preparation with a %s SSH directory', async (kind) => {
  const root = await mkdtemp(join(homedir(), 'scratch/terminal-ssh-test-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const ssh = join(root, 'ssh-source')
  const socket = kind === 'symlink' ? join(tmpdir(), `${basename(root)}.sock`) : join(root, 'ssh-agent.sock')
  const server = createServer()
  try {
    await Promise.all([mkdir(project), mkdir(ssh), mkdir(join(home, '.codex'), { recursive: true }), mkdir(join(home, '.local/state'), { recursive: true }), mkdir(join(home, '.cache'), { recursive: true })])
    if (kind === 'symlink')
      await symlink(ssh, join(home, '.ssh'))
    else
      await mkdir(join(home, '.ssh'))
    await writeFile(join(kind === 'symlink' ? ssh : join(home, '.ssh'), 'control-key'), 'fake-private-key')
    await writeFile(join(home, '.codex/auth.json'), 'fake-provider-login')
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, resolve)
    })
    await execute('git', ['init', project])
    const probe = join(project, 'probe.ts')
    await writeFile(probe, `import { existsSync, statSync, writeFileSync } from 'node:fs'
const home = ${JSON.stringify(home)}
writeFileSync(home + '/.codex/provider-write', 'allowed')
console.log(JSON.stringify({ key: existsSync(home + '/.ssh/control-key'), socket: existsSync(${JSON.stringify(socket)}) && statSync(${JSON.stringify(socket)}).isSocket(), socketEnvironment: process.env.SSH_AUTH_SOCK ?? null, providerAuth: existsSync(home + '/.codex/auth.json') }))
`)
    const environment = { ...process.env, SSH_AUTH_SOCK: socket }
    const sandbox = await prepareTerminalSandbox({ cwd: project, executable: process.execPath, argv: ['--experimental-strip-types', probe], environment, home })
    const provider = await execute(sandbox.executable, sandbox.argv, { env: sandbox.environment })
    expect(JSON.parse(provider.stdout)).toEqual({ key: false, socket: false, socketEnvironment: null, providerAuth: true })
    const previousSocket = process.env.SSH_AUTH_SOCK
    process.env.SSH_AUTH_SOCK = socket
    try {
      const prepare = await createTerminalPreparationRunner(project, join(project, 'claim'), [], home)
      const prepared = await prepare(process.execPath, ['--experimental-strip-types', probe], { cwd: project })
      expect(JSON.parse(prepared.stdout)).toEqual({ key: false, socket: false, socketEnvironment: null, providerAuth: true })
    }
    finally {
      if (previousSocket === undefined)
        delete process.env.SSH_AUTH_SOCK
      else
        process.env.SSH_AUTH_SOCK = previousSocket
    }
  }
  finally {
    if (server.listening)
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
