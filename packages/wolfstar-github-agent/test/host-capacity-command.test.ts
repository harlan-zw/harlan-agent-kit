import { execFile, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setHostSlotPolicy } from '../src/host-slot-policy.ts'
import { parseMaintenanceAuthority } from '../src/maintenance-scope.ts'

const command = resolve(import.meta.dirname, '../../wolfstar-github-edge/container/wolfstar-host-capacity')
const run = promisify(execFile)

let state: string
let previous: string | undefined
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'host-capacity-'))
  previous = process.env.WOLFSTAR_HOST_CAPACITY_STATE
  process.env.WOLFSTAR_HOST_CAPACITY_STATE = state
})
afterEach(() => {
  if (previous === undefined) delete process.env.WOLFSTAR_HOST_CAPACITY_STATE
  else process.env.WOLFSTAR_HOST_CAPACITY_STATE = previous
  rmSync(state, { recursive: true, force: true })
})

describe('single account host capacity command', () => {
  it('is executable, so the image can run it without a shell', () => {
    expect(statSync(command).mode & 0o111).not.toBe(0)
  })

  it('answers status in the shape the controller requires', async () => {
    const { stdout } = await run(command, ['status'])

    expect(() => parseMaintenanceAuthority(JSON.parse(stdout))).not.toThrow()
    expect(JSON.parse(stdout).policy).toEqual({ agentSlots: 0, maintenanceReserve: 0 })
  })

  it('records the policy the controller sets, and the controller accepts the answer', async () => {
    await expect(setHostSlotPolicy(command, 2)).resolves.toBeUndefined()

    const { stdout } = await run(command, ['status'])
    expect(JSON.parse(stdout).policy).toEqual({ agentSlots: 2, maintenanceReserve: 1 })
  })

  it('keeps one host and boot identity across calls', async () => {
    const first = JSON.parse((await run(command, ['status'])).stdout)
    const second = JSON.parse((await run(command, ['status'])).stdout)

    expect(second.hostId).toBe(first.hostId)
    expect(second.bootId).toBe(first.bootId)
  })

  it('refuses a policy the host cannot hold', async () => {
    for (const args of [['policy', '2', '3'], ['policy', 'x', '1'], ['policy', '999', '1'], ['policy']]) {
      await expect(run(command, args)).rejects.toMatchObject({ code: 2 })
    }
  })

  it('runs an admitted command with its output and exit code intact', () => {
    const ok = spawnSync(command, [
      'run',
      'maintenance:abc',
      '4',
      process.execPath,
      '-e',
      'console.log(JSON.stringify({a:1}))',
    ])
    const failed = spawnSync(command, ['run', 'maintenance:abc', '4', process.execPath, '-e', 'process.exit(7)'])

    expect(ok.stdout.toString()).toBe('{"a":1}\n')
    expect(ok.status).toBe(0)
    expect(failed.status).toBe(7)
  })

  it('hands each admitted command its own host reservation, which the maintenance worker requires', () => {
    const args = ['run', 'maintenance:abc', '4', process.execPath, '-e', 'console.log(process.env.WOLFSTAR_HOST_RESERVATION)']
    const first = spawnSync(command, args, { env: { ...process.env, WOLFSTAR_HOST_RESERVATION: '' } })
    const second = spawnSync(command, args)

    const reservations = [first, second].map((result) => result.stdout.toString().trim())
    expect(reservations[0]).not.toBe('')
    expect(reservations[1]).not.toBe('')
    expect(reservations[0]).not.toBe(reservations[1])
  })

  it('passes the proof channel through stdin', () => {
    const echoed = spawnSync(
      command,
      ['run', 'maintenance:abc', '4', process.execPath, '-e', 'process.stdin.pipe(process.stdout)'],
      {
        input: '{"id":1}\n',
      },
    )

    expect(echoed.stdout.toString()).toBe('{"id":1}\n')
  })

  it('refuses a run with no command', () => {
    expect(spawnSync(command, ['run', 'maintenance:abc', '4']).status).toBe(2)
  })
})
