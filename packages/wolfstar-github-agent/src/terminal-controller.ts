import type { IncomingMessage } from 'node:http'
import type { BrowserAuth } from './browser-auth.ts'
import type { TerminalDiffSnapshot, TerminalDiffSource } from './terminal-diff.ts'
import { timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverDesktopSessionProjects } from './desktop-session-projects.ts'
import { listTerminalDiff, readTerminalDiff } from './terminal-diff.ts'
import { createTerminalRuntime } from './terminal-runtime.ts'

export function terminalDashboardAccess(request: IncomingMessage, password: string): boolean {
  if (request.headers['x-wolfstar-agent-ingress'] === 'public') return false
  const header = request.headers.authorization
  if (!header?.startsWith('Basic ')) return false
  const supplied = Buffer.from(header.slice(6), 'base64').toString('utf8')
  const separator = supplied.indexOf(':')
  if (separator < 0) return false
  const value = Buffer.from(supplied.slice(separator + 1))
  const expected = Buffer.from(password)
  return (
    supplied.slice(0, separator) === 'agent' && value.length === expected.length && timingSafeEqual(value, expected)
  )
}

async function executable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const path = join(directory, name)
    const available = await access(path, constants.X_OK)
      .then(() => true)
      .catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT' || cause.code === 'EACCES' || cause.code === 'ENOTDIR') return false
        throw cause
      })
    if (available) return path
  }
  return join(homedir(), '.local', 'bin', name)
}

export function createTerminalDiffRequests(now: () => number) {
  const snapshots = new Map<string, { sessionId: string; expiresAt: number; snapshot: TerminalDiffSnapshot }>()
  return async (intent: { session: { id: string; worktree: string | null } }, url: URL): Promise<unknown> => {
    const path = intent.session.worktree
    if (path === null) return { _tag: 'Err', error: 'Unavailable' }
    for (const [id, entry] of snapshots) {
      if (entry.expiresAt <= now()) snapshots.delete(id)
    }
    const id = url.searchParams.get('snapshot')
    const file = url.searchParams.get('path')
    if (id !== null || file !== null) {
      const stored = id === null ? undefined : snapshots.get(id)
      if (file === null || stored === undefined || stored.sessionId !== intent.session.id)
        return { _tag: 'Err', error: 'Changed' }
      return readTerminalDiff(path, stored.snapshot, file)
    }
    const requested = url.searchParams.get('source') ?? 'working'
    const source: TerminalDiffSource | undefined =
      requested === 'working'
        ? { _tag: 'Working' }
        : requested === 'staged'
          ? { _tag: 'Staged' }
          : requested === 'comparison'
            ? { _tag: 'Comparison', base: url.searchParams.get('base') ?? '', head: url.searchParams.get('head') ?? '' }
            : undefined
    if (source === undefined) return { _tag: 'Err', error: 'InvalidRequest' }
    const result = await listTerminalDiff(path, source)
    if (result._tag === 'Err') return result
    if (snapshots.size >= 32) snapshots.delete(snapshots.keys().next().value!)
    snapshots.set(result.value.id, { sessionId: intent.session.id, expiresAt: now() + 60000, snapshot: result.value })
    return {
      _tag: 'Ok',
      value: {
        id: result.value.id,
        base: result.value.base,
        source: result.value.source,
        files: result.value.files.map(({ path, status }) => ({ path, status })),
      },
    }
  }
}

export async function createControllerTerminals(options: {
  directory: string
  origin: string
  listenOrigin: string
  password: string
  memoryGiB: number
  admissionCli: string
  protectedPaths: string[]
  browserAuth?: BrowserAuth
  publicBrowserAuth?: BrowserAuth
}) {
  const [codex, claude, opencode, projects] = await Promise.all([
    executable('codex'),
    executable('claude'),
    executable('opencode'),
    discoverDesktopSessionProjects(homedir()),
  ])
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'mjs'
  return createTerminalRuntime({
    directory: options.directory,
    origin: options.origin,
    origins: [...new Set([options.origin, options.listenOrigin])],
    hostLabel: 'Hogwild',
    controller: true,
    projects: projects.map(({ id, name, path }) => ({ id, name, path })),
    providers: {
      codex: { executable: codex, argv: ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write'] },
      claude: { executable: claude, argv: [] },
      opencode: { executable: opencode, argv: [] },
    },
    helperSource: fileURLToPath(new URL(`./terminal-helper.${extension}`, import.meta.url)),
    claimScript: fileURLToPath(new URL('../../../wolfstar-agent-kit/scripts/worktree-claim.sh', import.meta.url)),
    staticDirectory: fileURLToPath(new URL('../dashboard/.output/public', import.meta.url)),
    admissionCli: options.admissionCli,
    protectedPaths: options.protectedPaths,
    memoryGiB: options.memoryGiB,
    authorize: (request) => terminalDashboardAccess(request, options.password),
    ...(options.browserAuth ? { browserAuth: options.browserAuth } : {}),
    ...(options.publicBrowserAuth ? { publicBrowserAuth: options.publicBrowserAuth } : {}),
    diff: createTerminalDiffRequests(Date.now),
  })
}
