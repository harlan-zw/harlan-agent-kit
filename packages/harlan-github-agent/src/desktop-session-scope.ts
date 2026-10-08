import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export const SESSION_PROCESS_OWNER = 'HARLAN_SESSION_PROCESS_OWNER'

/** A cgroup removed after open returns ENODEV during read instead of ENOENT. */
async function readCgroup(path: string): Promise<string | null> {
  return await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENODEV')
      return null
    throw error
  })
}

async function inspect(unit: string) {
  if (!/^harlan-(?:session-[a-f0-9-]{36}|desktop-agent-\d+)\.scope$/.test(unit))
    throw new Error('The Session scope name is invalid.')
  const { stdout } = await exec('systemctl', ['--user', 'show', unit, '--property=LoadState,ControlGroup,ActiveState,InvocationID'])
  return Object.fromEntries(stdout.trim().split('\n').map(line => line.split('=')))
}
async function ownsScope(path: string | undefined, owner: string | undefined) {
  if (path === undefined || path === '' || owner === undefined)
    return false
  if (!path.startsWith('/') || path.split('/').includes('..'))
    throw new Error('The Session cgroup path is invalid.')
  const pids = await readCgroup(join('/sys/fs/cgroup', path, 'cgroup.procs'))
  if (pids === null)
    return false
  for (const pid of pids.trim().split('\n').filter(Boolean)) {
    const environment = await readFile(`/proc/${pid}/environ`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ESRCH')
        return null
      throw error
    })
    if (environment?.toString().split('\0').includes(`${SESSION_PROCESS_OWNER}=${owner}`))
      return true
  }
  return false
}
/** Bind an invocation only after a turn-owned process has entered the scope. */
export async function desktopSessionScopeInvocation(unit: string, owner: string): Promise<string | undefined> {
  const scope = await inspect(unit)
  return scope.InvocationID && await ownsScope(scope.ControlGroup, owner) ? scope.InvocationID : undefined
}

/** A removed cgroup proves no process remains, including children with empty environments. */
export async function stopDesktopSessionScope(unit: string, authority: { owner?: string, invocation?: string }, options: { graceMs?: number, timeoutMs?: number } = {}): Promise<void> {
  const before = await inspect(unit)
  if (before.LoadState === 'not-found')
    return
  if (authority.invocation !== undefined) {
    // systemd InvocationID changes when a PID-named scope belongs to a replacement turn.
    if (before.InvocationID !== authority.invocation)
      return
  }
  else if (!await ownsScope(before.ControlGroup, authority.owner)) {
    throw new Error('The Session scope owner cannot be verified.')
  }
  const command = async (args: string[]) => {
    await exec('systemctl', ['--user', ...args, unit], { timeout: 5000 }).catch(async (error: unknown) => {
      const current = await inspect(unit)
      if (current.LoadState === 'not-found' || current.InvocationID !== before.InvocationID)
        return
      throw error
    })
  }
  const empty = async () => {
    const current = await inspect(unit)
    if (current.LoadState === 'not-found' || current.InvocationID !== before.InvocationID)
      return true
    if (!current.ControlGroup)
      return current.ActiveState === 'inactive' || current.ActiveState === 'failed'
    const events = await readCgroup(join('/sys/fs/cgroup', current.ControlGroup, 'cgroup.events'))
    return events === null || /^populated 0$/m.test(events)
  }
  await command(['kill', '--kill-whom=all', '--signal=SIGTERM'])
  const grace = Date.now() + (options.graceMs ?? 10_000)
  while (!await empty() && Date.now() < grace)
    await delay(25)
  if (!await empty())
    await command(['kill', '--kill-whom=all', '--signal=SIGKILL'])
  const deadline = Date.now() + (options.timeoutMs ?? 5000)
  while (!await empty()) {
    if (Date.now() >= deadline)
      throw new Error('The Session scope did not stop.')
    await delay(25)
  }
  const current = await inspect(unit)
  if (current.LoadState === 'not-found' || current.InvocationID !== before.InvocationID)
    return
  await command(['stop'])
  const after = await inspect(unit)
  for (const path of new Set([before.ControlGroup, after.ControlGroup])) {
    if (path === undefined || path === '')
      continue
    if (!path.startsWith('/') || path.split('/').includes('..'))
      throw new Error('The Session cgroup path is invalid.')
    const events = await readCgroup(join('/sys/fs/cgroup', path, 'cgroup.events'))
    if (events !== null && !/^populated 0$/m.test(events))
      throw new Error('The Session scope still contains running processes.')
  }
  if (after.LoadState !== 'not-found' && !['inactive', 'failed'].includes(after.ActiveState ?? ''))
    throw new Error('The Session scope did not stop.')
}
