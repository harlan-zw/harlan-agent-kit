import type { TerminalLocalConfig } from './terminal-cli.ts'
import type { TerminalProvider } from './terminal-protocol.ts'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTerminalAdmissionCli } from './terminal-admission.ts'
import { buildTerminalArtifact } from './terminal-artifact.ts'
import { probeTerminalHelper } from './terminal-helper-client.ts'
import { createTerminalManager } from './terminal-manager.ts'
import { createTerminalServer } from './terminal-server.ts'
import { createTerminalSystemdHost } from './terminal-systemd.ts'
import { createTerminalWorktreeAdapter } from './terminal-worktree.ts'

export async function createTerminalRuntime(
  config: Omit<TerminalLocalConfig, 'controller'> & {
    controller: boolean
    origins?: string[]
    authorize?: Parameters<typeof createTerminalServer>[0]['authorize']
    browserAuth?: Parameters<typeof createTerminalServer>[0]['browserAuth']
    publicBrowserAuth?: Parameters<typeof createTerminalServer>[0]['publicBrowserAuth']
    diff?: Parameters<typeof createTerminalServer>[0]['diff']
    lockEntry?: string
    observer?: Parameters<typeof createTerminalServer>[0]['observer']
    controllerReadOnly?: boolean
  },
) {
  await mkdir(config.directory, { recursive: true, mode: 0o700 })
  const lockEntry =
    config.lockEntry ??
    fileURLToPath(
      new URL(
        import.meta.url.endsWith('.ts')
          ? './terminal-lock.ts'
          : createRequire(import.meta.url).resolve('wolfstar-github-agent/terminal-lock'),
        import.meta.url,
      ),
    )
  const child = spawn(
    'flock',
    ['--exclusive', '--nonblock', join(config.directory, 'api.lock'), process.execPath, lockEntry],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  )
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', (data) =>
      data.toString().includes('LOCKED') ? resolve() : reject(new Error('Terminal lock handshake failed')),
    )
    child.once('error', reject)
    child.once('exit', () => reject(new Error('Another terminal API owns this host directory')))
  })
  let active = true
  let ownershipLost: (() => void) | undefined
  child.once('exit', () => {
    active = false
    ownershipLost?.()
  })
  async function initialize() {
    const artifact = await buildTerminalArtifact({
      source: config.helperSource,
      claimScript: config.claimScript,
      directory: join(config.directory, 'artifacts'),
    })
    const providers = {} as Record<TerminalProvider, { executable: string; argv: string[]; available: boolean }>
    for (const provider of ['codex', 'claude', 'opencode'] as const) {
      const cli = config.providers[provider]
      const available = await access(cli.executable, constants.X_OK).then(
        () => true,
        (cause: NodeJS.ErrnoException) => {
          if (cause.code === 'ENOENT' || cause.code === 'EACCES') return false
          throw cause
        },
      )
      providers[provider] = { ...cli, available }
    }
    const manager = await createTerminalManager({
      ...config,
      projects: await Promise.all(
        config.projects.map(async (project) => ({
          ...project,
          path: await realpath(project.path),
        })),
      ),
      providers,
      artifact,
      claimScript: artifact.claimScript,
      bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
      admission: createTerminalAdmissionCli(config.admissionCli),
      processHost: createTerminalSystemdHost(process.execPath),
      ...createTerminalWorktreeAdapter(artifact.claimScript),
      ready: (intent) => probeTerminalHelper(config.directory, intent),
      now: () => new Date(),
      log: (message, cause) => console.error(message, cause instanceof Error ? cause.message : String(cause)),
      active: () => active,
    })
    const routes = createTerminalServer({
      manager,
      active: () => active,
      origin: config.origin,
      staticDirectory: config.staticDirectory,
      ...(config.origins ? { origins: config.origins } : {}),
      ...(config.authorize ? { authorize: config.authorize } : {}),
      ...(config.browserAuth ? { browserAuth: config.browserAuth } : {}),
      ...(config.publicBrowserAuth ? { publicBrowserAuth: config.publicBrowserAuth } : {}),
      ...(config.diff ? { diff: config.diff } : {}),
      ...(config.observer ? { observer: config.observer } : {}),
      now: Date.now,
      log: (message, cause) => console.error(message, cause instanceof Error ? cause.message : String(cause)),
    })
    ownershipLost = () => {
      void manager.close().catch((cause) => console.error('Terminal manager close failed', cause))
      void routes.close().catch((cause) => console.error('Terminal API close failed', cause))
    }
    if (!active) {
      ownershipLost()
      throw new Error('Terminal API ownership was lost')
    }
    return {
      manager,
      routes,
      async close() {
        active = false
        await Promise.all([manager.close(), routes.close()])
        const released =
          child.exitCode !== null
            ? Promise.resolve()
            : new Promise<void>((resolve) => child.once('exit', () => resolve()))
        child.stdin.end()
        await released
      },
    }
  }
  return initialize().catch((cause) => {
    child.stdin.end()
    throw cause
  })
}
