import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { checkAgentWorker, prepareAgentSandbox } from '../src/agent-sandbox.ts'
import { homeOverlayMissing } from './home-overlay.ts'

const execute = promisify(execFile)

async function fixture(root: string) {
  const controller = join(root, 'controller')
  const worker = join(root, 'worker')
  const primary = join(root, 'primary')
  await Promise.all([mkdir(controller), mkdir(join(worker, '.codex'), { recursive: true }), mkdir(primary)])
  await writeFile(join(worker, '.codex/auth.json'), 'login-1', { mode: 0o600 })
  await writeFile(join(worker, '.codex/AGENTS.md'), 'Shared instructions.')
  await execute('git', ['init', primary])
  await execute('git', ['-C', primary, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '--allow-empty', '-m', 'test: seed fixture'])
  const wtConfig = join(root, 'wt.toml')
  await writeFile(wtConfig, '[list]\njson-schema = 2\n')
  await execute('wt', ['--config', wtConfig, '-C', primary, 'switch', '--create', 'layer', '--base', 'HEAD', '--yes'])
  const worktrees = JSON.parse((await execute('wt', ['--config', wtConfig, '-C', primary, 'list', '--format=json'])).stdout)
  const workspace = worktrees.items.find((item: { branch: string }) => item.branch === 'layer').worktree.path as string
  const profile = join(root, 'worker.json')
  await writeFile(profile, JSON.stringify({ home: worker, tools: ['/usr/bin'], readOnlyPaths: [], codex: '/usr/bin/true', opencode: '/usr/bin/true' }))
  return { controller, worker, workspace, profile, layers: join(controller, '.local/share/harlan-github-agent/agent-home-layers') }
}

async function run(sandbox: Awaited<ReturnType<typeof prepareAgentSandbox>>, script: string) {
  return execute(sandbox.binary, [...sandbox.args, '/usr/bin/bash', '-c', script], { env: sandbox.environment })
}

it.skipIf(homeOverlayMissing)('keeps home writes outside the persisted paths to one turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-home-layer-'))
  try {
    const { controller, worker, workspace, profile, layers } = await fixture(root)
    const first = await prepareAgentSandbox({ workspace, environment: { HOME: controller }, profilePath: profile, provider: 'codex', taskId: 'owner/site:sentry-checkin:2026-11-24T00:00:00.000Z' })
    try {
      await run(first, `
        set -e
        echo planted >> ~/.bashrc
        mkdir -p ~/.local/bin && echo planted > ~/.local/bin/x
        echo '[mcp_servers.planted]' >> ~/.codex/config.toml
        # A login refresh commits through a temporary file in the same directory.
        echo login-2 > ~/.codex/auth.json.tmp && mv ~/.codex/auth.json.tmp ~/.codex/auth.json
        mkdir -p ~/.codex/sessions && echo session > ~/.codex/sessions/rollout
        mkdir -p ~/.local/share/pnpm/store/v11 && echo cached > ~/.local/share/pnpm/store/v11/entry
        echo run > ~/.local/state/sentry-checkin/history.tsv
        echo other > ~/.local/state/other-record
      `)
      // A second process in the same sandbox sees the same turn layer.
      await run(first, 'test -f ~/.local/bin/x && grep -q planted ~/.codex/config.toml')
    }
    finally {
      await first.release()
    }
    await expect(readdir(layers)).resolves.toEqual([])
    for (const path of ['.bashrc', '.local/bin/x', '.local/state/other-record'])
      await expect(lstat(join(worker, path))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(worker, '.codex/config.toml'), 'utf8')).not.toContain('planted')
    expect(await readFile(join(worker, '.codex/auth.json'), 'utf8')).toBe('login-2\n')
    expect(await readFile(join(worker, '.codex/sessions/rollout'), 'utf8')).toBe('session\n')
    expect(await readFile(join(worker, '.local/share/pnpm/store/v11/entry'), 'utf8')).toBe('cached\n')
    expect(await readFile(join(worker, '.local/state/sentry-checkin/history.tsv'), 'utf8')).toBe('run\n')

    const second = await prepareAgentSandbox({ workspace, environment: { HOME: controller }, profilePath: profile, provider: 'codex', taskId: 'opaque-issue-work-task' })
    try {
      const result = await run(second, `
        test ! -e ~/.bashrc || exit 10
        test ! -e ~/.local/bin/x || exit 11
        grep -q planted ~/.codex/config.toml && exit 12
        test "$(cat ~/.codex/auth.json)" = login-2 || exit 13
        test "$(cat ~/.local/share/pnpm/store/v11/entry)" = cached || exit 14
        echo isolated
      `)
      expect(result.stdout.trim()).toBe('isolated')
    }
    finally {
      await second.release()
    }
    await expect(readdir(layers)).resolves.toEqual([])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(homeOverlayMissing)('replaces what Codex loads as configuration, instructions, or code in each turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-home-codex-'))
  try {
    const { controller, worker, workspace, profile } = await fixture(root)
    await mkdir(join(worker, '.codex/plugins/cache'), { recursive: true })
    await writeFile(join(worker, '.codex/plugins/cache/planted'), 'earlier turn')
    await writeFile(join(worker, '.codex/config.toml'), '[mcp_servers.earlier]\n')
    // An alias from before the home layer must not decide where a mask lands.
    await writeFile(join(root, 'outside'), 'outside data')
    await symlink(join(root, 'outside'), join(worker, '.codex/.env'))
    const sandbox = await prepareAgentSandbox({ workspace, environment: { HOME: controller }, profilePath: profile, provider: 'codex', taskId: 'opaque-issue-work-task' })
    try {
      const result = await run(sandbox, `
        test ! -s ~/.codex/config.toml || exit 10
        test "$(cat ~/.codex/AGENTS.md)" = 'Shared instructions.' || exit 11
        test "$(cat ~/.codex/hooks.json)" = '{}' || exit 12
        test ! -s ~/.codex/.env && test ! -s ~/.codex/AGENTS.override.md || exit 13
        test ! -e ~/.codex/plugins/cache/planted || exit 14
        for file in .env AGENTS.override.md AGENTS.md hooks.json; do
          if echo planted > ~/.codex/$file; then exit 15; fi
        done
        for directory in plugins skills rules prompts shell_snapshots agents; do
          echo planted > ~/.codex/$directory/turn-file || exit 16
        done
        echo protected
      `)
      expect(result.stdout.trim()).toBe('protected')
    }
    finally {
      await sandbox.release()
    }
    expect(await readFile(join(root, 'outside'), 'utf8')).toBe('outside data')
    for (const directory of ['plugins', 'skills', 'rules', 'prompts', 'shell_snapshots', 'agents'])
      await expect(readFile(join(worker, '.codex', directory, 'turn-file'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(worker, '.codex/AGENTS.md'), 'utf8')).toBe('Shared instructions.')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(homeOverlayMissing)('refuses a persisted path that aliases a directory outside the shared home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-home-alias-'))
  try {
    const { controller, worker, workspace, profile, layers } = await fixture(root)
    await mkdir(join(controller, 'private'))
    await mkdir(join(worker, '.cargo'))
    await symlink(join(controller, 'private'), join(worker, '.cargo/registry'))

    await expect(prepareAgentSandbox({ workspace, environment: { HOME: controller }, profilePath: profile, provider: 'codex' })).rejects.toThrow('without aliases')
    await expect(readdir(layers)).resolves.toEqual([])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(homeOverlayMissing)('starts concurrent first turns on a home that predates the layer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-home-concurrent-'))
  try {
    const { controller, workspace, profile, layers } = await fixture(root)
    // A Service restart starts several Agents at once, before any turn created the Codex mount points.
    const sandboxes = await Promise.all(Array.from({ length: 4 }, (_, index) => prepareAgentSandbox({ workspace, environment: { HOME: controller }, profilePath: profile, provider: 'codex', taskId: `concurrent-${index}`, readOnly: true })))
    await Promise.all(sandboxes.map(sandbox => sandbox.release()))
    await expect(readdir(layers)).resolves.toEqual([])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('refuses Agent turns on a host whose bubblewrap cannot mount the home layer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-home-refusal-'))
  try {
    const { controller, workspace, profile } = await fixture(root)
    const unsupported = { _tag: 'Unsupported' as const, reason: 'Agent turns need bubblewrap 0.10 or later, with overlay mounts, for the worker home (fixture).' }

    await expect(checkAgentWorker({ HOME: controller }, profile, { homeOverlay: unsupported })).rejects.toThrow('bubblewrap 0.10 or later')
    await expect(prepareAgentSandbox({ workspace, environment: { HOME: controller }, profilePath: profile, provider: 'codex', homeOverlay: unsupported })).rejects.toThrow('bubblewrap 0.10 or later')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
