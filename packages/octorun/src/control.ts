import type { Socket } from 'node:net'
import type { JsonObject, JsonValue, Result, TaskFailure } from './types.ts'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { dirname } from 'node:path'
import { err, isJsonValue, ok } from './types.ts'

const frameBytes = 1048576
const responseBytes = 4194304
const failure = (message: string): Result<never> => err({ _tag: 'Configuration', message })
const record = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input)

function parseFrame(text: string): Result<unknown> {
  // Parsing errors are expected at this private protocol boundary. Do not expose raw request data in the error.
  try {
    return ok(JSON.parse(text) as unknown)
  }
  catch {
    return failure('Control response contains invalid JSON.')
  }
}

async function removeStaleSocket(path: string): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
  if (!existing)
    return
  if (!existing.isSocket())
    throw new Error('The control socket path contains a regular file. Choose a dedicated state directory.')
  const alive = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path)
    socket.setTimeout(1000, () => socket.destroy(new Error('Control socket connection timed out.')))
    socket.once('connect', () => {
      socket.end()
      resolve(true)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT')
        resolve(false)
      else
        reject(error)
    })
  })
  if (alive)
    throw new Error('An Octorun controller is already running for this state directory.')
  await unlink(path)
}

export async function startControlServer(options: { path: string, handle: (command: string, args: JsonObject) => Promise<Result<JsonValue>> }): Promise<{ close: () => Promise<void> }> {
  await mkdir(dirname(options.path), { recursive: true, mode: 0o700 })
  await chmod(dirname(options.path), 0o700)
  await removeStaleSocket(options.path)
  const connections = new Set<Socket>()
  const server = createServer((socket) => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
    let frame = Buffer.alloc(0)
    let accepted = false
    socket.setTimeout(15000, () => socket.destroy())
    const respond = (result: Result<JsonValue>) => {
      const payload = JSON.stringify(result)
      socket.end(`${Buffer.byteLength(payload) <= responseBytes ? payload : JSON.stringify(failure('Control response exceeds the four MiB limit. Request fewer logs.'))}\n`)
    }
    socket.on('error', () => {
      // A disconnected local client cannot receive a response. Runtime state remains durable in the controller.
    })
    socket.on('data', (chunk) => {
      if (accepted)
        return
      frame = Buffer.concat([frame, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
      if (frame.length > frameBytes) {
        accepted = true
        respond(failure('Control request exceeds the one MiB limit.'))
        return
      }
      const newline = frame.indexOf(10)
      if (newline < 0)
        return
      accepted = true
      const parsed = parseFrame(frame.subarray(0, newline).toString('utf8'))
      if (parsed._tag === 'Err') {
        respond(parsed)
        return
      }
      const input = parsed.value
      if (!record(input) || typeof input.command !== 'string' || !/^[a-z-]{1,32}$/.test(input.command) || !record(input.args) || !isJsonValue(input.args)) {
        respond(failure('Control request needs a command and JSON object arguments.'))
        return
      }
      socket.setTimeout(900000, () => socket.destroy())
      void options.handle(input.command, input.args as JsonObject).then(respond).catch(() => {
        respond(err({ _tag: 'Transient', message: 'The controller could not complete this operation. Check its logs.' }))
      })
    })
  })
  server.maxConnections = 32
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.path, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  await chmod(options.path, 0o600)
  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      for (const socket of connections)
        socket.destroy()
    }),
  }
}

export async function requestControl(options: { path: string, command: string, args: JsonObject, timeoutMs?: number }): Promise<Result<JsonValue> | null> {
  const payload = `${JSON.stringify({ command: options.command, args: options.args })}\n`
  if (Buffer.byteLength(payload) > frameBytes)
    return failure('Control request exceeds the one MiB limit.')
  return new Promise((resolve) => {
    const socket = createConnection(options.path)
    let frame = Buffer.alloc(0)
    let settled = false
    const finish = (result: Result<JsonValue> | null) => {
      if (settled)
        return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(options.timeoutMs ?? 900000, () => finish(err({ _tag: 'Transient', message: 'The controller operation timed out. Inspect its run before retrying.' })))
    socket.once('connect', () => socket.write(payload))
    socket.on('data', (chunk) => {
      frame = Buffer.concat([frame, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
      if (frame.length > responseBytes + 1024) {
        finish(failure('Control response exceeds the four MiB limit.'))
        return
      }
      const newline = frame.indexOf(10)
      if (newline < 0)
        return
      const result = parseFrame(frame.subarray(0, newline).toString('utf8'))
      if (result._tag === 'Err') {
        finish(result)
        return
      }
      const input = result.value
      if (record(input) && input._tag === 'Ok' && isJsonValue(input.value))
        finish(ok(input.value))
      else if (record(input) && input._tag === 'Err' && record(input.error) && ['Configuration', 'Authorization', 'Transient', 'Capacity', 'Permanent'].includes(String(input.error._tag)) && typeof input.error.message === 'string')
        finish(err({ _tag: input.error._tag as TaskFailure['_tag'], message: input.error.message }))
      else
        finish(failure('Control response does not match the Octorun protocol. Check both package versions.'))
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')
        finish(null)
      else if (error.code === 'EACCES' || error.code === 'EPERM')
        finish(err({ _tag: 'Authorization', message: 'The control socket denied access. Run Octorun as its state directory owner.' }))
      else
        finish(err({ _tag: 'Transient', message: 'The control connection failed. Inspect the controller before retrying.' }))
    })
    socket.once('end', () => finish(err({ _tag: 'Transient', message: 'The controller closed before confirming the result. Inspect state before retrying.' })))
  })
}
