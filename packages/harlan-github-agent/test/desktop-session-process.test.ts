import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { readDesktopSessionGroup, stopDesktopSessionGroup } from '../src/desktop-session-process.ts'

it('stops resistant descendants after the original group leader exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-process-'))
  const descendant = join(root, 'descendant.ts')
  await writeFile(descendant, `import process from 'node:process'
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
process.stdout.write('ready\\n')
`)
  const leaderPath = join(root, 'leader.ts')
  await writeFile(leaderPath, `import { spawn } from 'node:child_process'
import process from 'node:process'
const descendant = spawn(process.execPath, ['--experimental-strip-types', process.argv[2]!], { stdio: ['ignore', 'pipe', 'ignore'] })
descendant.stdout.once('data', () => process.stdout.write('ready\\n'))
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
`)
  const child = spawn(process.execPath, ['--experimental-strip-types', leaderPath, descendant], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  await once(child.stdout, 'data')
  const members = await readDesktopSessionGroup(child.pid!)
  const leader = members.find(member => member.pid === child.pid)!
  try {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
    await expect(stopDesktopSessionGroup({ pid: leader.pid, birth: leader.birth, members: [] }, { graceMs: 40, timeoutMs: 2000 })).rejects.toThrow('verified')
    await stopDesktopSessionGroup({ pid: leader.pid, birth: leader.birth, members }, { graceMs: 40, timeoutMs: 2000 })
    expect(await readDesktopSessionGroup(leader.pid)).toEqual([])
  }
  finally {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        console.error('Process fixture cleanup failed.', error)
    }
    await rm(root, { recursive: true, force: true })
  }
})
it('leaves a group alone when its birth identity does not match', async () => {
  const child = spawn(process.execPath, ['--interactive'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] })
  await delay(20)
  const group = await readDesktopSessionGroup(child.pid!)
  try {
    await stopDesktopSessionGroup({ pid: child.pid!, birth: 'different', members: [] }, { graceMs: 1, timeoutMs: 100 })
    expect(await readDesktopSessionGroup(child.pid!)).toEqual(group)
  }
  finally { process.kill(-child.pid!, 'SIGKILL') }
})
