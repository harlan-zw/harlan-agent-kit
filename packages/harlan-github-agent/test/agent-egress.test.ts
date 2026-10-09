import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { agentEgressAddress, publicIPv4 } from '../src/agent-egress.ts'

it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.1.1', '192.168.1.2', '169.254.169.254', '100.64.1.1', '0.0.0.0', '224.0.0.1', '198.18.0.1', '192.0.2.1', '::1', '::ffff:127.0.0.1'])('refuses the private or reserved address %s', async (address) => {
  await expect(agentEgressAddress(address)).rejects.toThrow('public IPv4')
})

it('pins a public numeric address and refuses a later private DNS answer', async () => {
  let calls = 0
  const resolve = async () => [{ address: calls++ === 0 ? '93.184.216.34' : '127.0.0.1', family: 4 }]
  expect(await agentEgressAddress('example.test', resolve)).toBe('93.184.216.34')
  await expect(agentEgressAddress('example.test', resolve)).rejects.toThrow('public IPv4')
})

it('refuses a mixed public and private DNS answer', async () => {
  await expect(agentEgressAddress('example.test', async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }])).rejects.toThrow('public IPv4')
})

it('accepts a public IPv4 destination', () => {
  expect(publicIPv4('1.1.1.1')).toBe(true)
})

it.each(['connect', 'http'])('keeps serving when clients disconnect before a %s refusal', (mode) => {
  const root = mkdtempSync(join(tmpdir(), 'egress-disconnect-'))
  try {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./fixtures/agent-egress-client-disconnect.ts', import.meta.url)), join(root, 'proxy.sock'), mode], { encoding: 'utf8', timeout: 20_000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Refused the destination after disconnected clients.')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})
