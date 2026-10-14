import type { TerminalClientMessage, TerminalServerMessage } from './terminal-protocol.ts'
import type { TerminalIntent } from './terminal-storage.ts'
import { connect } from 'node:net'
import { join } from 'node:path'

export function connectTerminalHelper(options: {
  directory: string
  intent: TerminalIntent
  message: (message: TerminalServerMessage) => void
  closed: (cause?: Error) => void
}) {
  const socket = connect(join(options.directory, 'sessions', options.intent.session.id, 'owner.sock'))
  socket.setEncoding('utf8')
  let buffer = ''
  let notified = false
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => socket.destroy(new Error('Terminal helper connection timed out')),
    5000,
  )
  socket.on('connect', () => {
    if (timer) clearTimeout(timer)
    timer = null
  })
  socket.on('data', (chunk) => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) {
      socket.destroy(new Error('Terminal helper frame exceeded limit'))
      return
    }
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      const message = JSON.parse(frame) as TerminalServerMessage
      options.message(message)
    }
  })
  socket.on('error', (cause) => {
    notified = true
    options.closed(cause)
  })
  socket.on('close', () => {
    if (timer) clearTimeout(timer)
    if (!notified) options.closed()
  })
  return {
    send(message: TerminalClientMessage) {
      if (socket.destroyed) return false
      if (socket.writableLength > 512 * 1024) {
        socket.destroy(new Error('Terminal input queue exceeded limit'))
        return false
      }
      return socket.write(`${JSON.stringify({ token: options.intent.helperToken, message })}\n`)
    },
    close: () => socket.destroy(),
  }
}
export async function probeTerminalHelper(directory: string, intent: TerminalIntent) {
  return new Promise<boolean>((resolve) => {
    const socket = connect(join(directory, 'sessions', intent.session.id, 'owner.sock'))
    socket.setEncoding('utf8')
    let received = ''
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 300)
    socket.on('connect', () =>
      socket.write(`${JSON.stringify({ token: intent.helperToken, message: { type: 'Probe' } })}\n`),
    )
    socket.on('data', (chunk) => {
      received += chunk
      if (received.length > 4096) {
        socket.destroy()
        return
      }
      if (!received.includes('\n')) return
      const message = JSON.parse(received.slice(0, received.indexOf('\n'))) as {
        type: string
        generation: string
        invocationId: string
      }
      clearTimeout(timer)
      socket.destroy()
      resolve(
        message.type === 'Ready' &&
          message.generation === intent.session.generation &&
          (!intent.invocationId || message.invocationId === intent.invocationId),
      )
    })
    socket.on('error', () => {
      /* A startup probe may arrive before the independent helper is ready. */ clearTimeout(timer)
      resolve(false)
    })
  })
}
