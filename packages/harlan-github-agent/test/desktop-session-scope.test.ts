import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { createDesktopSessionClient } from '../src/desktop-session-client.ts'
import { readDesktopSessionGroup } from '../src/desktop-session-process.ts'
import { desktopSessionScopeInvocation, stopDesktopSessionScope } from '../src/desktop-session-scope.ts'

it('recovers a persisted scope after launcher death and kills an empty-env resistant writer', async () => {
  const home = await mkdtemp(join(tmpdir(), 'session-scope-recovery-'))
  const owner = randomUUID()
  const turnId = randomUUID()
  const sessionId = randomUUID()
  const unit = `harlan-session-${turnId}.scope`
  const marker = join(home, 'marker')
  const writer = join(home, 'writer.ts')
  const executable = join(home, 'execute.ts')
  await writeFile(writer, `import { writeFileSync } from 'node:fs'
import process from 'node:process'
process.on('SIGTERM', () => {})
setInterval(() => writeFileSync(process.argv[2]!, String(Date.now())), 10)
process.stdout.write('ready')
`)
  await writeFile(executable, `import { spawn } from 'node:child_process'
import process from 'node:process'
const child = spawn(process.execPath, ['--experimental-strip-types', ${JSON.stringify(writer)}, ${JSON.stringify(marker)}], { env: {}, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
child.stdout.once('data', () => process.stdout.write('ready'))
child.unref()
setInterval(() => {}, 1000)
`)
  // A Stop can precede unit creation. A later Stop must still verify the new invocation.
  await stopDesktopSessionScope(unit, { owner })
  const child = spawn('systemd-run', ['--user', '--scope', '--quiet', '--unit', unit, process.execPath, '--experimental-strip-types', executable], { detached: true, env: { ...process.env, HARLAN_SESSION_PROCESS_OWNER: owner }, stdio: ['ignore', 'pipe', 'ignore'] })
  await once(child.stdout, 'data')
  const members = await readDesktopSessionGroup(child.pid!, owner)
  const leader = members.find(member => member.pid === child.pid)!
  const invocation = await desktopSessionScopeInvocation(unit, owner)
  expect(invocation).toBeTruthy()
  const fence = { host: 'hogwild' as const, instanceId: 'previous-instance', sessionId, turnId, leaseToken: 'previous-fence' }
  const directory = join(home, 'runtime', 'sessions', sessionId)
  await mkdir(join(directory, turnId), { recursive: true })
  await writeFile(join(directory, 'live.json'), JSON.stringify({ ...fence, ...leader, members, owner, unit, invocation }))
  await writeFile(join(directory, 'execution.lock'), 'previous-turn')
  await writeFile(join(directory, turnId, 'result.json'), JSON.stringify({ workspacePath: home, providerSessionId: 'native-saved' }))
  try {
    const exited = once(child, 'exit')
    process.kill(-child.pid!, 'SIGKILL')
    await exited
    await delay(30)
    let completed: unknown
    const client = createDesktopSessionClient({ host: 'hogwild', home, root: join(home, 'runtime'), signal: new AbortController().signal, transport: {
      report: async () => ({ accepted: true, stops: [fence] }),
      claim: async () => null,
      heartbeat: async () => ({ active: true, cancelled: false }),
      events: async () => ({ accepted: true }),
      defer: async () => ({ accepted: true }),
      complete: async (input) => {
        const before = await readFile(marker, 'utf8')
        await delay(60)
        expect(await readFile(marker, 'utf8')).toBe(before)
        completed = input
        return { accepted: true }
      },
    } })
    await client.report()
    expect(completed).toMatchObject({ ...fence, outcome: 'stopped', workspacePath: home, providerSessionId: 'native-saved' })
  }
  finally {
    await stopDesktopSessionScope(unit, { owner, ...(invocation === undefined ? {} : { invocation }) }, { graceMs: 20, timeoutMs: 2000 })
    await rm(home, { recursive: true, force: true })
  }
}, 20_000)

it('refuses a foreign PID-named scope and leaves a replacement invocation untouched', async () => {
  const owner = randomUUID()
  const unit = `harlan-desktop-agent-${process.pid}.scope`
  const child = spawn('systemd-run', ['--user', '--scope', '--quiet', '--unit', unit, process.execPath, '-e', 'process.stdout.write(\'ready\');setInterval(()=>{},1000)'], { detached: true, env: { ...process.env, HARLAN_SESSION_PROCESS_OWNER: owner }, stdio: ['ignore', 'pipe', 'ignore'] })
  await once(child.stdout, 'data')
  const invocation = await desktopSessionScopeInvocation(unit, owner)
  try {
    expect(await desktopSessionScopeInvocation(unit, 'previous-owner')).toBeUndefined()
    await expect(stopDesktopSessionScope(unit, { owner: 'previous-owner' })).rejects.toThrow('owner cannot be verified')
    await stopDesktopSessionScope(unit, { owner: 'previous-owner', invocation: 'previous-invocation' })
    expect(await desktopSessionScopeInvocation(unit, owner)).toBe(invocation)
  }
  finally { await stopDesktopSessionScope(unit, { owner, ...(invocation === undefined ? {} : { invocation }) }, { graceMs: 20, timeoutMs: 2000 }) }
})
