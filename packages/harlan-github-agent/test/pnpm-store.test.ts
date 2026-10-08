import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { runAgentSandboxCommand } from '../src/agent-sandbox.ts'

const execute = promisify(execFile)

it('keeps offline dependency installation data outside the Agent worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-pnpm-store-'))
  const home = join(root, 'controller')
  const worker = join(root, 'worker')
  const primary = join(root, 'primary')
  try {
    await Promise.all([home, worker, primary].map(path => mkdir(path)))
    const launcher = await realpath(process.env.HARLAN_AGENT_TEST_PNPM_BINARY ?? (await execute('which', ['pnpm'])).stdout.trim())
    const file = await open(launcher)
    const prefix = Buffer.alloc(8192)
    await file.read(prefix, 0, prefix.length, 0).finally(() => file.close())
    const shimTarget = /^# cmd-shim-target=(.+)$/m.exec(prefix.toString())?.[1]
    const pnpm = await realpath(shimTarget ?? launcher)
    const profile = join(root, 'worker.json')
    const pnpmPackage = basename(dirname(pnpm)) === 'bin' ? dirname(dirname(pnpm)) : dirname(pnpm)
    await writeFile(profile, JSON.stringify({ home: worker, codex: pnpm, opencode: pnpm, tools: [dirname(process.execPath), dirname(pnpm)], readOnlyPaths: [pnpmPackage] }))
    await mkdir(join(primary, 'dependency'))
    await writeFile(join(primary, 'dependency/package.json'), JSON.stringify({ name: 'offline-fixture', version: '1.0.0', main: 'value.json' }))
    await writeFile(join(primary, 'dependency/value.json'), JSON.stringify(42))
    await writeFile(join(primary, 'package.json'), JSON.stringify({ name: 'store-boundary', version: '1.0.0', dependencies: { 'offline-fixture': 'file:./dependency' } }))
    await writeFile(join(primary, '.gitignore'), 'node_modules\n.env\n')
    await execute('git', ['init', primary])
    await execute('git', ['-C', primary, 'remote', 'add', 'origin', 'https://github.com/owner/site.git'])
    await execute('git', ['-C', primary, 'add', '.'])
    await execute('git', ['-C', primary, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '-m', 'test: seed offline dependency'])
    const wtConfig = join(root, 'wt.toml')
    await writeFile(wtConfig, '[list]\njson-schema = 2\n')
    await execute('wt', ['--config', wtConfig, '-C', primary, 'switch', '--create', 'install', '--base', 'HEAD', '--yes'])
    const listed = JSON.parse((await execute('wt', ['--config', wtConfig, '-C', primary, 'list', '--format=json'])).stdout) as { items: Array<{ branch: string, worktree: { path: string } }> }
    const workspace = listed.items.find(item => item.branch === 'install')!.worktree.path
    const run = (command: string, args: string[]) => runAgentSandboxCommand({ workspace, command, args, signal: AbortSignal.timeout(20000), environment: { HOME: home, CI: 'true' }, profilePath: profile })
    const store = await run(pnpm, ['store', 'path'])
    expect(store.exitCode, store.stderr || store.stdout).toBe(0)
    expect(store.stdout.trim()).toMatch(/^\/home\/agent\/.local\/share\/pnpm\/store\/v\d+$/)
    await writeFile(join(workspace, '.env'), `pnpm_config_store_dir=${workspace}/generated-store\nPNPM_CONFIG_STORE-DIR=${workspace}/other-store\n`)
    const installation = await run(pnpm, ['install', '--offline', '--ignore-scripts'])
    expect(installation.exitCode, installation.stderr).toBe(0)
    const answer = await run('/run/agent/node', ['-e', 'console.log(require("offline-fixture"))'])
    expect(answer.stdout.trim()).toBe('42')
    const changes = await execute('git', ['-C', workspace, 'status', '--porcelain=v1', '--untracked-files=all'])
    expect(changes.stdout.trim()).toBe('?? pnpm-lock.yaml')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
