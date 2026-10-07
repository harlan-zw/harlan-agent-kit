import { Buffer } from 'node:buffer'
import process from 'node:process'
import { requestReviewProof } from './review-proof-transport.ts'
import { createReviewTools, REVIEW_TOOLS } from './review-tools.ts'

async function main(): Promise<void> {
  const [workspace, socketPath, evidencePath] = process.argv.slice(2)
  if (workspace === undefined || socketPath === undefined || evidencePath === undefined)
    throw new Error('The Review tools require a worktree, proof socket, and revision evidence.')
  const tools = createReviewTools({ workspace, evidencePath, proof: input => requestReviewProof(socketPath, input) })
  let pending = ''
  const send = (value: unknown) => {
    process.stdout.write(`${JSON.stringify(value)}\n`)
  }
  const handle = async (line: string) => {
    let input: unknown
    try {
      input = JSON.parse(line) as unknown
    }
    catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'The Review tools require JSON.' } })
      return
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'The Review tools require a request object.' } })
      return
    }
    const message = input as Record<string, unknown>
    if (message.id === undefined)
      return
    const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null
    if (message.jsonrpc !== '2.0' || id === null) {
      send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'The Review tools require a JSON-RPC request.' } })
      return
    }
    let result: unknown
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'controller-review', version: '1.0.0' } }
    }
    else if (message.method === 'ping') {
      result = {}
    }
    else if (message.method === 'tools/list') {
      result = { tools: REVIEW_TOOLS }
    }
    else if (message.method === 'tools/call') {
      const parameters = typeof message.params === 'object' && message.params !== null ? message.params as Record<string, unknown> : {}
      const value = await tools.call(parameters.name, parameters.arguments).catch((error: unknown) => ({ _tag: 'ToolFailed', reason: error instanceof Error ? error.message : String(error) }))
      result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: typeof value === 'object' && value !== null && '_tag' in value && value._tag === 'ToolFailed' }
    }
    else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'This Review method is unavailable.' } })
      return
    }
    send({ jsonrpc: '2.0', id, result })
  }
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    pending += chunk
    if (Buffer.byteLength(pending) > 128_000)
      throw new Error('The Review request exceeds its byte limit.')
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line.trim() !== '')
        await handle(line)
      newline = pending.indexOf('\n')
    }
  }
}
main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message : 'The Review tools failed.')
  process.exitCode = 1
})
