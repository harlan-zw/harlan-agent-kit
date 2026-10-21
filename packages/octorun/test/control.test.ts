import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { requestControl, startControlServer } from '../src/control.ts'

const roots: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

it('runs operator commands through a private Unix socket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octorun-control-'))
  roots.push(root)
  const path = join(root, 'control.sock')
  const calls: unknown[] = []
  const server = await startControlServer({ path, handle: async (command, args) => {
    calls.push({ command, args })
    return { _tag: 'Ok', value: { cancelled: true } }
  } })
  servers.push(server)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(await requestControl({ path, command: 'cancel', args: { runId: 'run-7' } })).toEqual({ _tag: 'Ok', value: { cancelled: true } })
  expect(calls).toEqual([{ command: 'cancel', args: { runId: 'run-7' } }])
})

it('distinguishes a missing controller from a rejected operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octorun-control-'))
  roots.push(root)
  const path = join(root, 'control.sock')
  expect(await requestControl({ path, command: 'status', args: {} })).toBeNull()
  servers.push(await startControlServer({ path, handle: async () => ({ _tag: 'Err', error: { _tag: 'Authorization', message: 'Operation is disabled.' } }) }))
  expect(await requestControl({ path, command: 'cancel', args: {} })).toEqual({ _tag: 'Err', error: { _tag: 'Authorization', message: 'Operation is disabled.' } })
})

it('refuses to replace a live controller socket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octorun-control-'))
  roots.push(root)
  const path = join(root, 'control.sock')
  servers.push(await startControlServer({ path, handle: async () => ({ _tag: 'Ok', value: true }) }))
  await expect(startControlServer({ path, handle: async () => ({ _tag: 'Ok', value: true }) })).rejects.toThrow('already running')
  expect(await requestControl({ path, command: 'status', args: {} })).toEqual({ _tag: 'Ok', value: true })
})
