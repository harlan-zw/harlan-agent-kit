import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createWorkerMemoryLimiter, workerMemoryCommand } from '../src/worker-memory.ts'

const execute = promisify(execFile)
const nativeTest = it.skipIf(process.env.XDG_RUNTIME_DIR === undefined)

nativeTest('places a worker outside the controller cgroup and enforces memory without swap', async () => {
  const command = await workerMemoryCommand({ binary: process.execPath, args: ['-e', `
    const fs = require('node:fs');
    const group = fs.readFileSync('/proc/self/cgroup', 'utf8').trim().split('::')[1];
    const scope = '/sys/fs/cgroup' + group;
    const root = scope.slice(0, scope.lastIndexOf('/'));
    console.log(JSON.stringify({group, maximum: fs.readFileSync(root + '/memory.max','utf8').trim(), swap: fs.readFileSync(root + '/memory.swap.max','utf8').trim(), oomGroup: fs.readFileSync(scope + '/memory.oom.group','utf8').trim()}));
  `], memoryGiB: 0.125 })
  const { stdout } = await execute(command.binary, command.args)
  const result = JSON.parse(stdout)
  expect(result.maximum).toBe(String(128 * 1024 * 1024))
  expect(result.swap).toBe('0')
  expect(result.oomGroup).toBe('1')
  expect(result.group).toMatch(/harlan-worker-[a-f0-9-]+\.scope$/)
  expect(result.group).not.toContain('harlan-github-agent.service')
  await command.release()
})

nativeTest('stops a worker at its memory budget and preserves the controller process', async () => {
  const command = await workerMemoryCommand({ binary: process.execPath, args: ['-e', 'const chunks=[]; for(let n=0;n<256;n++) chunks.push(Buffer.alloc(1024*1024,1)); setInterval(()=>{},1000)'], memoryGiB: 0.125 })
  try {
    await expect(execute(command.binary, command.args, { timeout: 10_000 })).rejects.toThrow()
    expect(await command.memoryExceeded()).toBe(true)
    expect(process.kill(process.pid, 0)).toBe(true)
  }
  finally {
    await command.release()
  }
})

nativeTest('shares one Task budget across its server and client processes', async () => {
  const taskId = randomUUID()
  const input = { binary: '/usr/bin/cat', args: ['/proc/self/cgroup'], memoryGiB: 1, taskId }
  const [server, client] = await Promise.all([workerMemoryCommand(input), workerMemoryCommand(input)])
  try {
    const [first, second] = await Promise.all([execute(server.binary, server.args), execute(client.binary, client.args)])
    const parent = (text: string) => text.trim().slice(0, text.trim().lastIndexOf('/'))
    expect(parent(first.stdout)).toBe(parent(second.stdout))
    await server.release()
    const group = parent(second.stdout).split('::')[1]
    expect((await readFile(`/sys/fs/cgroup${group}/memory.max`, 'utf8')).trim()).toBe(String(1024 ** 3))
  }
  finally {
    await server.release()
    await client.release()
  }
})

nativeTest('preserves a shared reservation during release and acquire overlap', async () => {
  const input = { binary: '/usr/bin/cat', args: ['/proc/self/cgroup'], memoryGiB: 0.125, taskId: randomUUID() }
  const old = await workerMemoryCommand(input)
  const oldGroup = (await execute(old.binary, old.args)).stdout.trim()
  const closing = old.release()
  const current = await workerMemoryCommand(input)
  try {
    await closing
    const currentGroup = (await execute(current.binary, current.args)).stdout.trim()
    const parent = (text: string) => text.split('::')[1]!.slice(0, text.split('::')[1]!.lastIndexOf('/'))
    const max = await readFile(`/sys/fs/cgroup${parent(currentGroup)}/memory.max`, 'utf8')
    expect(max.trim()).toBe(String(128 * 1024 * 1024))
    if (parent(currentGroup) !== parent(oldGroup))
      await expect(readFile(`/sys/fs/cgroup${parent(oldGroup)}/memory.max`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }
  finally {
    await current.release()
  }
})

it('keeps a replacement bounded while the old systemd stop waits', async () => {
  const active = new Map<string, string>()
  const stopped: string[] = []
  const configured: string[] = []
  let unblock: () => void = () => {}
  let stopping: () => void = () => {}
  const stopStarted = new Promise<void>((resolve) => { stopping = resolve })
  const stopWait = new Promise<void>((resolve) => { unblock = resolve })
  const command = createWorkerMemoryLimiter({
    newId: randomUUID,
    readEvents: async () => 'oom_kill 0\n',
    execute: async (args) => {
      const action = args[1]
      const unit = args[action === 'set-property' ? 3 : 2]!
      if (action === 'set-property') {
        configured.push(unit)
        active.set(unit, args[4]!)
      }
      if (action === 'show')
        return { stdout: `/user.slice/test/${unit}\n` }
      if (action === 'stop') {
        if (unit === configured[0]) {
          stopping()
          await stopWait
        }
        stopped.push(unit)
        active.delete(unit)
      }
      return { stdout: '' }
    },
  })
  const input = { binary: '/usr/bin/true', args: [], memoryGiB: 1, taskId: 'same-task' }
  const old = await command(input)
  const closing = old.release()
  await stopStarted
  const replacement = await command(input)
  unblock()
  await closing
  expect(stopped).toEqual([configured[0]])
  expect([...active.values()]).toEqual(['MemoryMax=1073741824'])
  await Promise.all([replacement.release(), replacement.release()])
  expect(stopped).toEqual(configured)
})

it('removes its owned memory group when startup fails', async () => {
  const cleaned: string[] = []
  const command = createWorkerMemoryLimiter({
    newId: randomUUID,
    readEvents: async () => 'oom_kill 0\n',
    execute: async (args) => {
      if (args[1] === 'start')
        throw new Error('The user manager refused startup.')
      if (args[1] === 'stop' || args[1] === 'revert')
        cleaned.push(args[1])
      return { stdout: '' }
    },
  })
  await expect(command({ binary: '/usr/bin/true', args: [], memoryGiB: 1 })).rejects.toThrow('refused startup')
  expect(cleaned).toEqual(['stop', 'revert'])
})
