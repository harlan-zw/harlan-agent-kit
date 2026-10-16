import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
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
