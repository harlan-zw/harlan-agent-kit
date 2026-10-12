import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createTerminalPreparationRunner, prepareTerminalSandbox } from '../src/terminal-sandbox.ts'

const execute = promisify(execFile)

it('uses HTTPS for GitHub preparation without changing stored remotes or unrelated transports', async () => {
  const root = await mkdtemp(join(homedir(), 'scratch/terminal-git-test-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  try {
    await Promise.all([mkdir(project), mkdir(join(home, '.local/state'), { recursive: true }), mkdir(join(home, '.cache'), { recursive: true })])
    await execute('git', ['init', project])
    const prepare = await createTerminalPreparationRunner(project, join(project, 'claim'), [], home, {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'test.existing',
      GIT_CONFIG_VALUE_0: 'preserved',
    })
    const existing = await prepare('git', ['config', '--get', 'test.existing'], { cwd: project })
    expect(existing.stdout.trim()).toBe('preserved')
    for (const [remote, transport] of [
      ['git@github.com:harlan-zw/harlan-agent-kit.git', 'https://github.com/harlan-zw/harlan-agent-kit.git'],
      ['ssh://git@github.com/harlan-zw/harlan-agent-kit.git', 'https://github.com/harlan-zw/harlan-agent-kit.git'],
      ['git@example.com:owner/repo.git', 'git@example.com:owner/repo.git'],
      ['git@github.com.evil.test:owner/repo.git', 'git@github.com.evil.test:owner/repo.git'],
    ] as const) {
      await execute('git', ['config', 'remote.origin.url', remote], { cwd: project })
      const resolved = await prepare('git', ['remote', 'get-url', 'origin'], { cwd: project })
      expect(resolved.stdout.trim()).toBe(transport)
      const stored = await execute('git', ['config', '--get', 'remote.origin.url'], { cwd: project })
      expect(stored.stdout.trim()).toBe(remote)
    }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

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
