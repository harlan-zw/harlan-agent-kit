import { expect, it, vi } from 'vitest'
import { queueEmergencyPowerOff } from '../src/emergency-poweroff.ts'

it('queues one delayed graceful shutdown through the fixed system command', () => {
  const run = vi.fn()
  queueEmergencyPowerOff(run)
  expect(run).toHaveBeenCalledExactlyOnceWith('/usr/bin/systemd-run', [
    '--quiet',
    '--unit=hogwild-phone-poweroff',
    '--on-active=5s',
    '--timer-property=AccuracySec=1s',
    '/usr/bin/systemctl',
    'poweroff',
  ])
})

it('reports a refused scheduler without retrying the power command', () => {
  const run = vi.fn(() => {
    throw new Error('scheduler refused')
  })
  expect(() => queueEmergencyPowerOff(run)).toThrow('scheduler refused')
  expect(run).toHaveBeenCalledTimes(1)
})
