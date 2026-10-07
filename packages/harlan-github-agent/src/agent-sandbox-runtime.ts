import type { AddressInfo, Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import process from 'node:process'

function relay(socket: Socket, target: { host: string, port: number } | { path: string }): void {
  const outgoing = connect(target)
  socket.pipe(outgoing)
  outgoing.pipe(socket)
  socket.once('error', () => outgoing.destroy())
  outgoing.once('error', () => socket.destroy())
  socket.once('close', () => outgoing.destroy())
  outgoing.once('close', () => socket.destroy())
}

async function main(): Promise<void> {
  const proxy = createServer(socket => relay(socket, { path: '/run/agent/egress/proxy.sock' }))
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(0, '127.0.0.1', resolve)
  })
  const proxyPort = (proxy.address() as AddressInfo).port
  const environment = { ...process.env, HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, http_proxy: `http://127.0.0.1:${proxyPort}`, https_proxy: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', NODE_USE_ENV_PROXY: '1' }
  const mode = process.argv[2]
  const binary = process.argv[3]
  if (!binary)
    throw new Error('The Agent runtime needs a provider executable.')
  const args = process.argv.slice(4)
  let transport: ReturnType<typeof createServer> | undefined
  if (mode === 'opencode-client') {
    transport = createServer(socket => relay(socket, { path: '/run/agent/transport/opencode.sock' }))
    await new Promise<void>((resolve, reject) => {
      transport!.once('error', reject)
      transport!.listen(4097, '127.0.0.1', resolve)
    })
    const attach = args.indexOf('--attach')
    if (attach === -1)
      throw new Error('The OpenCode client needs its turn server.')
    args[attach + 1] = 'http://127.0.0.1:4097'
  }
  if (mode === 'opencode-server') {
    transport = createServer(socket => relay(socket, { host: '127.0.0.1', port: 4097 }))
    await new Promise<void>((resolve, reject) => {
      transport!.once('error', reject)
      transport!.listen('/run/agent/transport/opencode.sock', resolve)
    })
  }
  const child = spawn(binary, args, { env: environment, stdio: 'inherit' })
  child.once('error', (error) => {
    process.stderr.write(`${error.message}\n`)
    proxy.close()
    transport?.close()
    process.exitCode = 1
  })
  child.once('exit', (code) => {
    proxy.close()
    transport?.close()
    process.exitCode = code ?? 1
  })
  process.once('SIGTERM', () => child.kill('SIGTERM'))
  process.once('SIGINT', () => child.kill('SIGINT'))
}

void main().catch((error: unknown) => {
  process.stderr.write(`Agent runtime failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
