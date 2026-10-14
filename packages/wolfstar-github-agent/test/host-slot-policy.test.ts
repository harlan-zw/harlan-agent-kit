import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { setHostSlotPolicy } from '../src/host-slot-policy.ts'

const directories: string[] = []
async function authority(response: unknown, exitCode = 0, raw = false) {
  const directory = await mkdtemp(join(tmpdir(), 'host-policy-'))
  directories.push(directory)
  const command = join(directory, 'authority.ts')
  const receipt = join(directory, 'arguments.json')
  const output = raw ? String(response) : JSON.stringify(response)
  await writeFile(
    command,
    `#!${process.execPath} --experimental-strip-types\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)))\nprocess.stdout.write(${JSON.stringify(output)})\nprocess.exitCode = ${exitCode}\n`,
  )
  await chmod(command, 0o700)
  return { command, arguments: () => readFile(receipt, 'utf8').then((text) => JSON.parse(text) as string[]) }
}
function status(slots: number, reserve = Math.min(1, slots)) {
  return { _tag: 'Status', hostId: 'host', bootId: 'boot', policy: { agentSlots: slots, maintenanceReserve: reserve } }
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('shared host slot policy', () => {
  it.each([0, 1, 2, 256])('accepts an exact policy for %i total slots', async (slots) => {
    const cli = await authority(status(slots))
    await expect(setHostSlotPolicy(cli.command, slots)).resolves.toBeUndefined()
    expect(await cli.arguments()).toEqual(['policy', String(slots), String(Math.min(1, slots))])
  })
  it.each([
    { _tag: 'Status', policy: { agentSlots: 2, maintenanceReserve: 1 } },
    { _tag: 'Admitted', hostId: 'host', bootId: 'boot', policy: { agentSlots: 2, maintenanceReserve: 1 } },
    { _tag: 'Status', hostId: 'host', bootId: 'boot', policy: { agentSlots: '2', maintenanceReserve: 1 } },
  ])('rejects an invalid authority status', async (response) => {
    const cli = await authority(response)
    await expect(setHostSlotPolicy(cli.command, 2)).rejects.toThrow(
      'The shared host capacity authority is unavailable or outdated.',
    )
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
  it.each([-1, 257, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid input before starting the authority',
    async (slots) => {
      const cli = await authority(status(2))
      await expect(setHostSlotPolicy(cli.command, slots)).rejects.toThrow('Set a valid Agent slot count.')
      await expect(cli.arguments()).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )
})
