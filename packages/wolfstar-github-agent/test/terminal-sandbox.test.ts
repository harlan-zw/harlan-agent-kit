import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createTerminalPreparationRunner, prepareTerminalSandbox } from '../src/terminal-sandbox.ts'

const execute = promisify(execFile)

it('installs and runs a provider update inside isolated package manager state', async () => {
  const root = await mkdtemp(join(homedir(), 'scratch/terminal-provider-update-test-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const fixture = join(project, 'provider')
  try {
    await Promise.all([mkdir(join(home, '.local/bin'), { recursive: true }), mkdir(fixture, { recursive: true })])
    const host = join(home, '.local/bin/codex')
    await writeFile(host, '#!/bin/sh\necho host-provider\n', { mode: 0o755 })
    await writeFile(
      join(fixture, 'package.json'),
      JSON.stringify({ name: 'terminal-provider-update-fixture', version: '1.0.0', bin: { codex: 'cli.js' } }),
    )
    await writeFile(join(fixture, 'cli.js'), '#!/usr/bin/env node\nconsole.log("updated-provider")\n', { mode: 0o755 })
    const environment = {
      ...process.env,
      HOME: home,
      npm_config_manage_package_manager_versions: 'false',
      npm_config_store_dir: join(home, '.cache/wolfstar-terminal/pnpm/store'),
    }
    const original = await prepareTerminalSandbox({
      cwd: project,
      executable: host,
      provider: 'codex',
      argv: [],
      environment,
      home,
    })
    expect((await execute(original.executable, original.argv, { env: original.environment })).stdout.trim()).toBe(
      'host-provider',
    )
    const sandbox = await prepareTerminalSandbox({
      cwd: project,
      executable: '/usr/bin/env',
      argv: ['pnpm', 'add', '-g', fixture, '--offline', '--ignore-scripts'],
      environment,
      home,
    })
    await execute(sandbox.executable, sandbox.argv, { env: sandbox.environment })
    const updated = await prepareTerminalSandbox({
      cwd: project,
      executable: host,
      provider: 'codex',
      argv: [],
      environment,
      home,
    })
    const result = await execute(updated.executable, updated.argv, { env: updated.environment })
    expect(result.stdout.trim()).toBe('updated-provider')
    expect((await execute(host)).stdout.trim()).toBe('host-provider')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('runs the deployed claim tool while keeping its private Service parent hidden', async () => {
  const root = await mkdtemp(join(homedir(), 'scratch/terminal-deployed-claim-test-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const privateService = join(home, '.local/share/wolfstar-github-agent')
  const claimScript = join(privateService, 'service/wolfstar-agent-kit/scripts/worktree-claim.sh')
  try {
    await Promise.all([
      mkdir(project),
      mkdir(join(home, '.local/state'), { recursive: true }),
      mkdir(join(home, '.cache'), { recursive: true }),
      mkdir(join(privateService, 'service/wolfstar-agent-kit/scripts'), { recursive: true }),
    ])
    await writeFile(
      claimScript,
      await readFile(fileURLToPath(new URL('../../../wolfstar-agent-kit/scripts/worktree-claim.sh', import.meta.url))),
    )
    await writeFile(join(privateService, 'private-cookie'), 'fake-private-cookie')
    await execute('git', ['init', project])
    const prepare = await createTerminalPreparationRunner(project, claimScript, [], home)
    const acquired = await prepare('bash', [
      claimScript,
      'acquire',
      '--path',
      project,
      '--session',
      'terminal-fixture',
      '--durable',
    ])
    expect(JSON.parse(acquired.stdout)).toMatchObject({ claimed: true, durable: true, session: 'terminal-fixture' })
    const probe = await prepare('bash', [
      '-c',
      'test ! -e "$1/private-cookie" && test ! -e "$2"',
      'probe',
      privateService,
      claimScript,
    ])
    expect(probe.stderr).toBe('')
    const released = await prepare('bash', [claimScript, 'release', '--path', project, '--session', 'terminal-fixture'])
    expect(JSON.parse(released.stdout)).toMatchObject({ released: true })
    const immutable = await prepare('bash', [
      '-c',
      'if printf changed >> /tmp/wolfstar-terminal-preparation/worktree-claim.sh 2>/dev/null; then exit 1; fi',
    ])
    expect(immutable.stdout).toBe('')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('gives provider tools writable package manager state without changing host launchers', async () => {
  const root = await mkdtemp(join(homedir(), 'scratch/terminal-tool-state-test-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  try {
    await Promise.all([mkdir(join(home, '.local/share/pnpm'), { recursive: true }), mkdir(project)])
    const probe = join(project, 'probe.ts')
    await writeFile(
      probe,
      `import { mkdirSync, writeFileSync } from 'node:fs'\nconst state = process.env.PNPM_HOME\nmkdirSync(state, { recursive: true })\nwriteFileSync(state + '/fixture-state', 'package-manager-state')\ntry { writeFileSync(${JSON.stringify(join(home, '.local/share/pnpm/host-launcher'))}, 'modified') } catch (error) { console.log(error.code) }\n`,
    )
    const sandbox = await prepareTerminalSandbox({
      cwd: project,
      executable: process.execPath,
      argv: [probe],
      environment: { ...process.env, PNPM_HOME: join(home, '.local/share/pnpm') },
      home,
    })
    const result = await execute(sandbox.executable, sandbox.argv, { env: sandbox.environment })
    expect(result.stdout.trim()).toBe('EROFS')
    expect(await readFile(join(home, '.cache/wolfstar-terminal/pnpm/fixture-state'), 'utf8')).toBe(
      'package-manager-state',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['.cache', '.cache/wolfstar-terminal'])(
  'rejects package manager state through a symlink at %s',
  async (link) => {
    const root = await mkdtemp(join(homedir(), 'scratch/terminal-tool-state-link-'))
    const home = join(root, 'home')
    const project = join(root, 'project')
    const target = join(root, 'target')
    try {
      await Promise.all([mkdir(home), mkdir(project), mkdir(target)])
      if (link !== '.cache') await mkdir(join(home, '.cache'))
      await symlink(target, join(home, link))
      await expect(
        prepareTerminalSandbox({ cwd: project, executable: '/usr/bin/true', argv: [], environment: process.env, home }),
      ).rejects.toThrow('ordinary host directories')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

it('uses HTTPS for GitHub preparation without changing stored remotes or unrelated transports', async () => {
  const root = await mkdtemp(join(homedir(), 'scratch/terminal-git-test-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  try {
    await Promise.all([
      mkdir(project),
      mkdir(join(home, '.local/state'), { recursive: true }),
      mkdir(join(home, '.cache'), { recursive: true }),
    ])
    await execute('git', ['init', project])
    await writeFile(join(project, 'claim'), '#!/bin/bash\nexit 0\n')
    const prepare = await createTerminalPreparationRunner(project, join(project, 'claim'), [], home, {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'test.existing',
      GIT_CONFIG_VALUE_0: 'preserved',
    })
    const existing = await prepare('git', ['config', '--get', 'test.existing'], { cwd: project })
    expect(existing.stdout.trim()).toBe('preserved')
    for (const [remote, transport] of [
      [
        'git@github.com:wolfstar-project/wolfstar-agent-kit.git',
        'https://github.com/wolfstar-project/wolfstar-agent-kit.git',
      ],
      [
        'ssh://git@github.com/wolfstar-project/wolfstar-agent-kit.git',
        'https://github.com/wolfstar-project/wolfstar-agent-kit.git',
      ],
      ['git@example.com:owner/repo.git', 'git@example.com:owner/repo.git'],
      ['git@github.com.evil.test:owner/repo.git', 'git@github.com.evil.test:owner/repo.git'],
    ] as const) {
      await execute('git', ['config', 'remote.origin.url', remote], { cwd: project })
      const resolved = await prepare('git', ['remote', 'get-url', 'origin'], { cwd: project })
      expect(resolved.stdout.trim()).toBe(transport)
      const stored = await execute('git', ['config', '--get', 'remote.origin.url'], { cwd: project })
      expect(stored.stdout.trim()).toBe(remote)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['directory', 'symlink'] as const)(
  'hides host SSH credentials from provider and preparation with a %s SSH directory',
  async (kind) => {
    const root = await mkdtemp(join(homedir(), 'scratch/terminal-ssh-test-'))
    const home = join(root, 'home')
    const project = join(root, 'project')
    const ssh = join(root, 'ssh-source')
    const socket = kind === 'symlink' ? join(tmpdir(), `${basename(root)}.sock`) : join(root, 'ssh-agent.sock')
    const server = createServer()
    try {
      await Promise.all([
        mkdir(project),
        mkdir(ssh),
        mkdir(join(home, '.codex'), { recursive: true }),
        mkdir(join(home, '.local/state'), { recursive: true }),
        mkdir(join(home, '.cache'), { recursive: true }),
      ])
      if (kind === 'symlink') await symlink(ssh, join(home, '.ssh'))
      else await mkdir(join(home, '.ssh'))
      await writeFile(join(kind === 'symlink' ? ssh : join(home, '.ssh'), 'control-key'), 'fake-private-key')
      await writeFile(join(home, '.codex/auth.json'), 'fake-provider-login')
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socket, resolve)
      })
      await execute('git', ['init', project])
      await writeFile(join(project, 'claim'), '#!/bin/bash\nexit 0\n')
      const probe = join(project, 'probe.ts')
      await writeFile(
        probe,
        `import { existsSync, statSync, writeFileSync } from 'node:fs'
const home = ${JSON.stringify(home)}
writeFileSync(home + '/.codex/provider-write', 'allowed')
console.log(JSON.stringify({ key: existsSync(home + '/.ssh/control-key'), socket: existsSync(${JSON.stringify(socket)}) && statSync(${JSON.stringify(socket)}).isSocket(), socketEnvironment: process.env.SSH_AUTH_SOCK ?? null, providerAuth: existsSync(home + '/.codex/auth.json') }))
`,
      )
      const environment = { ...process.env, SSH_AUTH_SOCK: socket }
      const sandbox = await prepareTerminalSandbox({
        cwd: project,
        executable: process.execPath,
        argv: ['--experimental-strip-types', probe],
        environment,
        home,
      })
      const provider = await execute(sandbox.executable, sandbox.argv, { env: sandbox.environment })
      expect(JSON.parse(provider.stdout)).toEqual({
        key: false,
        socket: false,
        socketEnvironment: null,
        providerAuth: true,
      })
      const previousSocket = process.env.SSH_AUTH_SOCK
      process.env.SSH_AUTH_SOCK = socket
      try {
        const prepare = await createTerminalPreparationRunner(project, join(project, 'claim'), [], home)
        const prepared = await prepare(process.execPath, ['--experimental-strip-types', probe], { cwd: project })
        expect(JSON.parse(prepared.stdout)).toEqual({
          key: false,
          socket: false,
          socketEnvironment: null,
          providerAuth: true,
        })
      } finally {
        if (previousSocket === undefined) delete process.env.SSH_AUTH_SOCK
        else process.env.SSH_AUTH_SOCK = previousSocket
      }
    } finally {
      if (server.listening)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      await rm(root, { recursive: true, force: true })
    }
  },
)
