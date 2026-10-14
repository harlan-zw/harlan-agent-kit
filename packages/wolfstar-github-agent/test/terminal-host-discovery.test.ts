import { expect, it, vi } from 'vitest'
import { discoverTerminalHost } from '../dashboard/app/utils/terminal-host-discovery.ts'

it('loads a hosted Dashboard without requesting refused public terminal capabilities', async () => {
  const capabilities = vi.fn(async () => {
    throw Object.assign(new Error('Public terminals refused'), { statusCode: 403 })
  })
  expect(await discoverTerminalHost({ _tag: 'Dashboard' }, capabilities)).toEqual({ _tag: 'Dashboard' })
  expect(capabilities).not.toHaveBeenCalled()
})
it('keeps refused local terminal discovery separate from a hosted Dashboard', async () => {
  expect(
    await discoverTerminalHost({ _tag: 'TerminalHost' }, async () => {
      throw Object.assign(new Error('Pairing required'), { statusCode: 403 })
    }),
  ).toEqual({ _tag: 'PairingRequired' })
})
