import type { KeyEvent } from 'ghostty-terminal-bindings'
import type { TerminalHelperConfig } from './terminal-manager.ts'
import { execFile } from 'node:child_process'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createGhostty, encodeKey, encodeTextCommit } from 'ghostty-terminal-bindings'
import { spawn } from 'node-pty'
import { createTerminalAdmissionCli } from './terminal-admission.ts'
import { createTerminalOwner } from './terminal-owner.ts'
import { parseTerminalClientMessage, parseTerminalJson } from './terminal-protocol.ts'
import { createTerminalPreparationRunner, prepareTerminalSandbox } from './terminal-sandbox.ts'
import { writeTerminalJson } from './terminal-storage.ts'
import { createTerminalSystemdHost } from './terminal-systemd.ts'
import { createTerminalWorktreeAdapter } from './terminal-worktree.ts'

const execute = promisify(execFile)
export async function runTerminalHelper(config: TerminalHelperConfig) {
  if (
    config.protocol !== 1 ||
    !config.intent.reservationId ||
    process.env.WOLFSTAR_HOST_RESERVATION !== config.intent.reservationId
  ) {
    throw new Error('Terminal helper reservation is missing')
  }
  const wasm = await readFile(config.wasm)
  if (createHash('sha256').update(wasm).digest('hex') !== config.wasmDigest)
    throw new Error('Terminal helper engine changed')
  const scope = await createTerminalSystemdHost(process.execPath).inspect(config.intent.unit)
  if (!scope.invocationId || scope.mainPid !== process.pid) throw new Error('Terminal helper identity is unavailable')
  const admission = createTerminalAdmissionCli(config.admissionCli)
  const bound = await admission.bind({
    key: `terminal:${config.intent.session.id}`,
    reservationId: config.intent.reservationId,
    unit: config.intent.unit,
    invocationId: scope.invocationId,
  })
  if (bound._tag !== 'Bound' || bound.scope.invocationId !== scope.invocationId)
    throw new Error('Terminal helper admission was refused')
  // This barrier precedes every provider spawn. Cancelled Starting reservations cannot run a provider.
  const preparation = await createTerminalPreparationRunner(
    config.project.path,
    config.claimScript,
    config.protectedPaths,
  )
  const cwd = await createTerminalWorktreeAdapter(config.claimScript, preparation).prepare(
    config.project,
    config.intent.session.id,
  )
  await writeTerminalJson(join(config.directory, 'sessions', config.intent.session.id, 'prepared.json'), {
    generation: config.intent.session.generation,
    invocationId: scope.invocationId,
    worktree: cwd,
  })
  const commonGit = (
    await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })
  ).stdout.trim()
  const sandbox = await prepareTerminalSandbox({
    cwd,
    executable: config.executable,
    argv: config.argv,
    environment: process.env,
    writable: [commonGit],
    denied: config.protectedPaths,
  })
  const ghostty = await createGhostty(wasm, () => {
    /* Terminal diagnostics do not enter raw-output recordings. */
  })
  const terminal = ghostty.createTerminal(100, 30, {
    scrollbackLimit: 2 * 1024 * 1024,
  })
  const encoder = ghostty.createKeyEncoder()
  const pty = spawn(sandbox.executable, sandbox.argv, {
    cwd,
    cols: 100,
    rows: 30,
    name: 'xterm-256color',
    env: sandbox.environment,
  })
  const owner = createTerminalOwner({
    session: { ...config.intent.session, worktree: cwd, state: 'Running' },
    emulator: terminal,
    encoder: {
      encode: (event) => encodeKey(terminal, encoder, event as KeyEvent),
      dispose: () => encoder.dispose(),
    },
    encodeText: (text) => encodeTextCommit(terminal, encoder, text),
    pty,
    now: Date.now,
    token: randomUUID,
  })
  pty.onData((bytes) => owner.output(bytes))
  pty.onExit(() => {
    owner.exited()
    // systemd stops the whole owned cgroup, including surviving provider descendants.
    void execute('systemctl', ['--user', 'stop', config.intent.unit], {
      timeout: 15000,
    }).catch((cause) => {
      console.error('Terminal scope stop failed', cause instanceof Error ? cause.message : String(cause))
    })
  })
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer((socket) => {
    if (sockets.size >= 8) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    let viewId: string | null = null
    socket.on('data', (chunk) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 128 * 1024) {
        socket.destroy()
        return
      }
      for (;;) {
        const end = buffer.indexOf('\n')
        if (end < 0) break
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        const decoded = parseTerminalJson(frame)
        if (decoded._tag === 'Err' || typeof decoded.value !== 'object' || decoded.value === null) {
          socket.destroy()
          return
        }
        const request = decoded.value as { token?: unknown; message?: unknown }
        if (
          typeof request.token !== 'string' ||
          Buffer.byteLength(request.token) !== Buffer.byteLength(config.intent.helperToken) ||
          !timingSafeEqual(Buffer.from(request.token), Buffer.from(config.intent.helperToken))
        ) {
          socket.destroy()
          return
        }
        if (
          typeof request.message === 'object' &&
          request.message !== null &&
          'type' in request.message &&
          request.message.type === 'Probe'
        ) {
          socket.write(
            `${JSON.stringify({ type: 'Ready', generation: config.intent.session.generation, invocationId: scope.invocationId })}\n`,
          )
          continue
        }
        const parsed = parseTerminalClientMessage(request.message)
        if (parsed._tag === 'Err') {
          socket.write(`${JSON.stringify({ type: 'Failure', reason: parsed.reason })}\n`)
          continue
        }
        const message = parsed.value
        if (message.type === 'Attach') {
          if (viewId) {
            socket.destroy()
            return
          }
          viewId = message.viewId
          const result = owner.attach(viewId, message.generation, (response) => {
            if (socket.destroyed) return
            if (socket.writableLength > 8 * 1024 * 1024) {
              socket.destroy()
              return
            }
            socket.write(`${JSON.stringify(response)}\n`)
          })
          if (result._tag === 'Err') {
            socket.write(`${JSON.stringify({ type: 'Failure', reason: result.reason })}\n`)
          }
        } else {
          const result = viewId
            ? owner.message(viewId, message)
            : ({ _tag: 'Err', reason: 'SessionUnavailable' } as const)
          if (result._tag === 'Err') {
            socket.write(`${JSON.stringify({ type: 'Failure', reason: result.reason })}\n`)
          }
        }
      }
    })
    socket.on('error', (cause) => console.error('Terminal attachment failed', cause.message))
    socket.on('close', () => {
      sockets.delete(socket)
      if (viewId) owner.detach(viewId)
    })
  })
  server.on('error', (cause) => {
    throw cause
  })
  await new Promise<void>((resolve) =>
    server.listen(join(config.directory, 'sessions', config.intent.session.id, 'owner.sock'), resolve),
  )
  let sent = -1
  const render = setInterval(() => {
    // Poll only the revision. Inactive views produce no screen copies or recording.
    if (sockets.size && sent !== owner.revision) {
      owner.publish()
      sent = owner.revision
    }
    void owner.writer
  }, 33)
  const renew = setInterval(
    () => {
      void execute(
        'bash',
        [
          config.claimScript,
          'acquire',
          '--path',
          cwd,
          '--session',
          `terminal-${config.intent.session.id}`,
          '--durable',
        ],
        { timeout: 10000 },
      ).catch((cause) => {
        console.error('Terminal Worktree claim renewal failed', cause instanceof Error ? cause.message : String(cause))
      })
    },
    5 * 60 * 1000,
  )
  process.on('SIGTERM', () => {
    clearInterval(render)
    clearInterval(renew)
    for (const socket of sockets) socket.destroy()
    server.close()
    owner.dispose()
    process.exit(0)
  })
  return { owner, server }
}
async function main() {
  const configPath = process.argv[2]
  if (!configPath) throw new Error('Terminal helper configuration is missing')
  await runTerminalHelper(JSON.parse(await readFile(configPath, 'utf8')) as TerminalHelperConfig)
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exit(1)
  })
}
