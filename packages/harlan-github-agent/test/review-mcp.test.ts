import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('serves the real stdio protocol with bounded static tools and refuses execution names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-mcp-'))
  try {
    await writeFile(join(root, 'source.ts'), 'export const proof = "safe"')
    const evidence = join(root, 'evidence.json')
    await writeFile(evidence, JSON.stringify({ _tag: 'Unavailable', reason: 'The fixture has no Git revisions.' }))
    const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../src/review-mcp.ts', import.meta.url)), root, join(root, 'unused.sock'), evidence], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let error = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      error += chunk
    })
    const exit = new Promise<number | null>((resolve) => {
      child.once('close', resolve)
    })
    child.stdin.end([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'review_read', arguments: { path: 'source.ts' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bash', arguments: { command: 'touch owned' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'review_read', arguments: { revision: 'diff', path: '' } } },
    ].map(message => `${JSON.stringify(message)}\n`).join(''))
    expect(await exit, error).toBe(0)
    const messages = output.trim().split('\n').map(line => JSON.parse(line) as { result: unknown })
    expect(JSON.stringify(messages[0])).toContain('controller-review')
    expect(JSON.stringify(messages[1])).toContain('safe')
    expect(JSON.stringify(messages[2])).toContain('unavailable')
    expect(JSON.stringify(messages[3])).toContain('The fixture has no Git revisions.')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
