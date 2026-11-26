import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { effectiveMaintenanceReserve, parseHostSharedMemory, readHostSharedMemory, setHostSlotPolicy } from '../src/host-slot-policy.ts'

const directories: string[] = []
async function authority(response: unknown, exitCode = 0, raw = false) {
  const directory = await mkdtemp(join(tmpdir(), 'host-policy-'))
  directories.push(directory)
  const command = join(directory, 'authority.ts')
  const receipt = join(directory, 'arguments.json')
  const output = raw ? String(response) : JSON.stringify(response)
  await writeFile(command, `#!${process.execPath} --experimental-strip-types\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)))\nprocess.stdout.write(${JSON.stringify(output)})\nprocess.exitCode = ${exitCode}\n`)
  await chmod(command, 0o700)
  return { command, arguments: () => readFile(receipt, 'utf8').then(text => JSON.parse(text) as string[]) }
}
function status(slots: number, reserve = Math.min(1, slots)) {
  return { _tag: 'Status', hostId: 'host', bootId: 'boot', policy: { agentSlots: slots, maintenanceReserve: reserve } }
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('shared host slot policy', () => {
  it.each([0, 1, 2, 256])('accepts an exact policy for %i total slots', async (slots) => {
    const cli = await authority(status(slots))
    await expect(setHostSlotPolicy(cli.command, slots)).resolves.toBeUndefined()
    expect(await cli.arguments()).toEqual(['policy', String(slots), String(Math.min(1, slots))])
  })
  it('accepts maintenanceReserve=0 while keeping interactive slots available', async () => {
    const cli = await authority(status(4, 0))
    await expect(setHostSlotPolicy(cli.command, 4, 0)).resolves.toBeUndefined()
    expect(await cli.arguments()).toEqual(['policy', '4', '0'])
    expect(effectiveMaintenanceReserve(4, true)).toBe(0)
    expect(effectiveMaintenanceReserve(4, false)).toBe(1)
    expect(effectiveMaintenanceReserve(0, false)).toBe(0)
  })
  it.each([-1, 2, 1.5])('rejects invalid explicit maintenance reserve %s', async (reserve) => {
    const cli = await authority(status(4, 1))
    await expect(setHostSlotPolicy(cli.command, 4, reserve)).rejects.toThrow('Set a valid maintenance Reserve count.')
    await expect(cli.arguments()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each([
    { _tag: 'Status', policy: { agentSlots: 2, maintenanceReserve: 1 } },
    { _tag: 'Admitted', hostId: 'host', bootId: 'boot', policy: { agentSlots: 2, maintenanceReserve: 1 } },
    { _tag: 'Status', hostId: 'host', bootId: 'boot', policy: { agentSlots: '2', maintenanceReserve: 1 } },
  ])('rejects an invalid authority status', async (response) => {
    const cli = await authority(response)
    await expect(setHostSlotPolicy(cli.command, 2)).rejects.toThrow('The shared host capacity authority is unavailable or outdated.')
  })
  it.each([status(3), status(2, 0)])('rejects a policy different from the request', async (response) => {
    const cli = await authority(response)
    await expect(setHostSlotPolicy(cli.command, 2)).rejects.toThrow('The host refused the Agent slot policy.')
  })
  it('rejects invalid JSON from the command', async () => {
    const cli = await authority('not JSON', 0, true)
    await expect(setHostSlotPolicy(cli.command, 2)).rejects.toBeInstanceOf(SyntaxError)
  })
  it('propagates a failed command even when its output describes the desired policy', async () => {
    const cli = await authority(status(2), 75)
    await expect(setHostSlotPolicy(cli.command, 2)).rejects.toMatchObject({ code: 75 })
  })
  it.each([-1, 257, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid input before starting the authority', async (slots) => {
    const cli = await authority(status(2))
    await expect(setHostSlotPolicy(cli.command, slots)).rejects.toThrow('Set a valid Agent slot count.')
    await expect(cli.arguments()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('reads aggregate shared memory and paused Actions expansion from broker status', async () => {
    const cli = await authority({
      _tag: 'Status',
      hostId: 'host',
      bootId: 'boot',
      memoryGiB: 42,
      actionsMemoryGiB: 52,
      reservedGiB: 32,
      policy: { agentSlots: 4, maintenanceReserve: 0 },
      reservations: {
        'actions:a': { kind: 'actions', memoryGiB: 16 },
        'actions:b': { kind: 'actions', memoryGiB: 6 },
        'agent:1': { kind: 'agent', memoryGiB: 8 },
      },
    })
    await expect(readHostSharedMemory(cli.command)).resolves.toEqual({
      memoryGiB: 42,
      actionsMemoryGiB: 52,
      reservedGiB: 32,
      maintenanceReserve: 0,
      actions: 2,
      agents: 1,
    })
    expect(await cli.arguments()).toEqual(['status'])
    expect(parseHostSharedMemory({ _tag: 'Status', memoryGiB: 42, reservedGiB: 10, policy: { maintenanceReserve: 1 } })).toEqual({
      memoryGiB: 42,
      actionsMemoryGiB: 42,
      reservedGiB: 10,
      maintenanceReserve: 1,
      actions: 0,
      agents: 0,
    })
    expect(parseHostSharedMemory({ _tag: 'Status', memoryGiB: 42, actionsMemoryGiB: 30, reservedGiB: 0, policy: { maintenanceReserve: 0 } })).toBeUndefined()
  })
})
