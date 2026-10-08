import { readdir, readFile } from 'node:fs/promises'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

export interface DesktopSessionProcess { pid: number, birth: string }
export interface DesktopSessionGroup extends DesktopSessionProcess { members: DesktopSessionProcess[] }
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
export async function readDesktopSessionGroup(pid: number): Promise<DesktopSessionProcess[]> {
  const states = await Promise.all((await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(name => readProcess(Number(name))))
  return states.filter((state): state is ProcessState => state !== null && state.group === pid && state.state !== 'Z' && state.state !== 'X').map(({ pid, birth }) => ({ pid, birth })).sort((a, b) => a.pid - b.pid)
}
function ownsGroup(group: DesktopSessionGroup, members: DesktopSessionProcess[]): boolean {
  return members.some(member => (member.pid === group.pid && member.birth === group.birth)
    || group.members.some(saved => saved.pid === member.pid && saved.birth === member.birth))
}
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
      throw error
  }
}
/** Verify group ownership before signals. Finish only when every live member is gone. */
export async function stopDesktopSessionGroup(group: DesktopSessionGroup, options: { graceMs?: number, timeoutMs?: number } = {}): Promise<void> {
  const members = await readDesktopSessionGroup(group.pid)
  if (members.length === 0)
    return
  const leader = members.find(member => member.pid === group.pid)
  // A reused leader PID proves the old group ended. Never signal the replacement.
  if (leader !== undefined && leader.birth !== group.birth)
    return
  if (!ownsGroup(group, members))
    throw new Error('The previous session process group cannot be verified.')
  const known = { ...group, members: [...group.members, ...members] }
  signalGroup(group.pid, 'SIGTERM')
  const graceEnd = Date.now() + (options.graceMs ?? 10_000)
  while (Date.now() < graceEnd) {
    const remaining = await readDesktopSessionGroup(group.pid)
    if (remaining.length === 0)
      return
    if (!ownsGroup(known, remaining))
      throw new Error('The session process group identity changed.')
    await delay(Math.min(50, Math.max(1, graceEnd - Date.now())))
  }
  const remaining = await readDesktopSessionGroup(group.pid)
  if (remaining.length === 0)
    return
  if (!ownsGroup(known, remaining))
    throw new Error('The session process group identity changed.')
  signalGroup(group.pid, 'SIGKILL')
  const deadline = Date.now() + (options.timeoutMs ?? 5000)
  while ((await readDesktopSessionGroup(group.pid)).length > 0) {
    if (Date.now() >= deadline)
      throw new Error('The session process group did not stop.')
    await delay(20)
  }
}
