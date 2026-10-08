import { readdir, readFile } from 'node:fs/promises'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { SESSION_PROCESS_OWNER, stopDesktopSessionScope } from './desktop-session-scope.ts'

export { SESSION_PROCESS_OWNER } from './desktop-session-scope.ts'

export interface DesktopSessionProcess { pid: number, birth: string }
export interface DesktopSessionGroup extends DesktopSessionProcess { members: DesktopSessionProcess[], owner?: string, unit?: string, invocation?: string }
interface ProcessState extends DesktopSessionProcess { group: number, state: string }
async function readProcess(pid: number): Promise<ProcessState | null> {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ESRCH')
      return null
    throw error
  })
  if (text === null)
    return null
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
  return { pid, birth: fields[19]!, state: fields[0]!, group: Number(fields[2]) }
}
/** Zombies cannot write files. They may remain until an unrelated parent reaps them. */
export async function readDesktopSessionGroup(pid: number, owner?: string): Promise<DesktopSessionProcess[]> {
  const states = await Promise.all((await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(name => readProcess(Number(name))))
  const members = await Promise.all(states.map(async (state) => {
    if (state === null || state.state === 'Z' || state.state === 'X')
      return null
    if (state.group === pid)
      return state
    if (owner === undefined)
      return null
    const environment = await readFile(`/proc/${state.pid}/environ`).catch((error: NodeJS.ErrnoException) => {
      // Other users and processes which exit during discovery are outside this turn.
      if (error.code === 'ENOENT' || error.code === 'ESRCH' || error.code === 'EACCES')
        return null
      throw error
    })
    if (environment === null || !environment.toString().split('\0').includes(`${SESSION_PROCESS_OWNER}=${owner}`))
      return null
    const current = await readProcess(state.pid)
    return current?.birth === state.birth ? state : null
  }))
  return members.filter((state): state is ProcessState => state !== null).map(({ pid, birth }) => ({ pid, birth })).sort((a, b) => a.pid - b.pid)
}
function ownsGroup(group: DesktopSessionGroup, members: DesktopSessionProcess[]): boolean {
  return members.some(member => (member.pid === group.pid && member.birth === group.birth)
    || group.members.some(saved => saved.pid === member.pid && saved.birth === member.birth))
}
async function ownedMembers(group: DesktopSessionGroup): Promise<DesktopSessionProcess[]> {
  const members = await readDesktopSessionGroup(group.pid)
  const leader = members.find(member => member.pid === group.pid)
  const owned = (leader === undefined || leader.birth === group.birth) && ownsGroup(group, members)
  if (group.owner === undefined)
    return members
  if (members.length > 0 && (leader === undefined || leader.birth === group.birth) && !owned)
    throw new Error('The previous session process group cannot be verified.')
  // The original PGID can be reused after its leader exits. Tagged descendants
  // remain owned, but a replacement group must never receive our signals.
  const tagged = await readDesktopSessionGroup(-1, group.owner)
  const saved = await Promise.all(group.members.map(async (member) => {
    const current = await readProcess(member.pid)
    return current?.birth === member.birth && current.state !== 'Z' && current.state !== 'X' ? member : null
  }))
  return [...(owned ? members : []), ...tagged, ...saved.filter((member): member is DesktopSessionProcess => member !== null)].filter((member, index, all) => all.findIndex(item => item.pid === member.pid && item.birth === member.birth) === index)
}
async function signalMembers(members: DesktopSessionProcess[], signal: NodeJS.Signals) {
  for (const member of members) {
    if ((await readProcess(member.pid))?.birth !== member.birth)
      continue
    try {
      process.kill(member.pid, signal)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        throw error
    }
  }
}
/** Verify group ownership before signals. Finish only when every live member is gone. */
async function stopProcesses(group: DesktopSessionGroup, options: { graceMs?: number, timeoutMs?: number } = {}): Promise<void> {
  const members = await ownedMembers(group)
  if (members.length === 0)
    return
  const leader = members.find(member => member.pid === group.pid)
  // A reused leader PID proves the old group ended. Never signal the replacement.
  if (leader !== undefined && leader.birth !== group.birth && group.owner === undefined)
    return
  if (group.owner === undefined && !ownsGroup(group, members))
    throw new Error('The previous session process group cannot be verified.')
  const known = { ...group, members: [...group.members, ...members] }
  await signalMembers(members, 'SIGTERM')
  const graceEnd = Date.now() + (options.graceMs ?? 10_000)
  while (Date.now() < graceEnd) {
    const remaining = await ownedMembers(known)
    if (remaining.length === 0)
      return
    if (group.owner === undefined && !ownsGroup(known, remaining))
      throw new Error('The session process group identity changed.')
    await delay(Math.min(50, Math.max(1, graceEnd - Date.now())))
  }
  const remaining = await ownedMembers(known)
  if (remaining.length === 0)
    return
  if (group.owner === undefined && !ownsGroup(known, remaining))
    throw new Error('The session process group identity changed.')
  await signalMembers(remaining, 'SIGKILL')
  const deadline = Date.now() + (options.timeoutMs ?? 5000)
  while (true) {
    const survivors = await ownedMembers(known)
    if (survivors.length === 0)
      return
    if (Date.now() >= deadline)
      throw new Error('The session process group did not stop.')
    await signalMembers(survivors, 'SIGKILL')
    await delay(20)
  }
}

/** Stop the scope before and after its launcher, covering a concurrent scope start. */
export async function stopDesktopSessionGroup(group: DesktopSessionGroup, options: { graceMs?: number, timeoutMs?: number } = {}): Promise<void> {
  if (group.unit !== undefined)
    await stopDesktopSessionScope(group.unit, group, options)
  await stopProcesses(group, options)
  if (group.unit !== undefined)
    await stopDesktopSessionScope(group.unit, group, options)
}
