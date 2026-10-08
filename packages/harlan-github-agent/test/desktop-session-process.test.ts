import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    await stopDesktopSessionGroup({ pid: child.pid!, birth: 'different', members: [], owner: 'another-turn' }, { graceMs: 1, timeoutMs: 100 })
    expect(await readDesktopSessionGroup(child.pid!)).toEqual(group)
  }
  finally { process.kill(-child.pid!, 'SIGKILL') }
})

it('stops detached and reparented writers using the inherited turn owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-detached-'))
  const marker = join(root, 'marker')
  const owner = `session-detached-${process.pid}-${Date.now()}`
  const writerPath = join(root, 'writer.ts')
  const leaderPath = join(root, 'leader.ts')
  await writeFile(writerPath, `import { writeFileSync } from 'node:fs'
import process from 'node:process'
process.on('SIGTERM', () => {})
setInterval(() => writeFileSync(process.argv[2]!, String(Date.now())), 10)
process.stdout.write(String(process.pid))
`)
  await writeFile(leaderPath, `import { spawn } from 'node:child_process'
import process from 'node:process'
const child = spawn(process.execPath, ['--experimental-strip-types', process.argv[2]!, process.argv[3]!], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
child.stdout.once('data', data => process.stdout.write(data))
child.unref()
setInterval(() => {}, 1000)
`)
  const child = spawn(process.execPath, ['--experimental-strip-types', leaderPath, writerPath, marker], { detached: true, env: { ...process.env, HARLAN_SESSION_PROCESS_OWNER: owner }, stdio: ['ignore', 'pipe', 'ignore'] })
  const [ready] = await once(child.stdout, 'data')
  const writerPid = Number(String(ready))
  const leader = (await readDesktopSessionGroup(child.pid!)).find(member => member.pid === child.pid)!
  try {
    const members = await readDesktopSessionGroup(child.pid!)
    child.kill('SIGTERM')
    await once(child, 'exit')
    await delay(40)
    await stopDesktopSessionGroup({ ...leader, members, owner }, { graceMs: 40, timeoutMs: 2000 })
    const before = await readFile(marker, 'utf8')
    await delay(60)
    expect(await readFile(marker, 'utf8')).toBe(before)
  }
  finally {
    for (const pid of [child.pid!, writerPid]) {
      try {
        process.kill(-pid, 'SIGKILL')
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          console.error('Process fixture cleanup failed.', error)
      }
    }
    await rm(root, { recursive: true, force: true })
  }
})
