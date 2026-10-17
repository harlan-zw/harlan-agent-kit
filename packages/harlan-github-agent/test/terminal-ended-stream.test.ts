import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
it.each(['Exited', 'Interrupted'])('keeps the host alive and retries archived history after storage recovery for %s', async (state) => {
  const fixture = fileURLToPath(new URL('./fixtures/terminal-ended-history.ts', import.meta.url))
  const result = await execute(process.execPath, [fixture, state], { timeout: 5000 })
  expect(JSON.parse(result.stdout)).toEqual({
    failed: { type: 'Failure', reason: 'SessionUnavailable' },
    recovered: {
      type: 'History',
      generation: 'generation',
      requestId: 'retry',
      result: { _tag: 'Page', snapshot: 'saved', total: 1, offset: 0, lines: ['saved output'] },
    },
    status: 200,
    health: { alive: true },
    messages: ['Terminal history read failed'],
  })
})

it.each(['Exited', 'Interrupted'])('survives malformed WebSocket frames when a session is %s', async (state) => {
  const fixture = fileURLToPath(new URL('./fixtures/terminal-ended-stream-protocol.ts', import.meta.url))
  const result = await execute(process.execPath, [fixture, state], { timeout: 5000 })
  expect(JSON.parse(result.stdout)).toEqual({
    status: 200,
    health: { alive: true },
    closeCode: 1002,
    messages: ['Terminal stream failed'],
  })
})
