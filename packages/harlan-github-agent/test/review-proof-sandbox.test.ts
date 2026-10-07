import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createReviewProofLauncher } from '../src/review-proof-process.ts'
import { prepareReviewProofSandbox } from '../src/review-proof-sandbox.ts'

it('denies credentials, sockets, inspector, and child processes without relying on Node permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proof-os-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(join(root, 'secret'), 'fake-controller-credential')
  await symlink(join(root, 'secret'), join(workspace, 'secret-alias'))
  const socketPath = join(workspace, 'credential.sock')
  let connections = 0
  const server = createServer((socket) => {
    connections++
    socket.end('fake-socket-credential')
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  try {
    const sourcePath = join(root, 'source.ts')
    await writeFile(sourcePath, `
import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { connect } from 'node:net'
import * as inspector from 'node:inspector'
assert.equal(process.pid, 1)
assert.equal(process.ppid, 0)
for (const fd of readdirSync('/proc/self/fd')) {
  try {
    assert.equal(readlinkSync('/proc/self/fd/' + fd).endsWith('filter.bpf'), false)
  } catch (error) {
    // Reading the directory closes its own transient descriptor.
    assert.equal(error.code, 'ENOENT')
  }
}
assert.throws(() => readFileSync(${JSON.stringify(join(workspace, 'secret-alias'))}))
assert.throws(() => execFileSync('/usr/bin/true'), { code: 'EPERM' })
assert.throws(() => fork('/run/proof/proof.ts', [], { silent: true }), { code: 'EPERM' })
process._debugProcess(process.pid)
process.kill(process.pid, 'SIGUSR1')
inspector.open(9229, '127.0.0.1', false)
assert.equal(inspector.url(), undefined)
for (const endpoint of [${JSON.stringify(socketPath)}, 9229]) {
  const error = await new Promise(resolve => {
    const socket = typeof endpoint === 'string' ? connect(endpoint) : connect(endpoint, '127.0.0.1')
    socket.once('error', resolve)
    socket.once('connect', () => { socket.destroy(); resolve({ code: 'CONNECTED' }) })
  })
  assert.equal(error.code, 'EPERM')
}
console.log('OS boundaries held')
`, { mode: 0o400 })
    // Omitting --permission tests OS isolation independently of Node's permission model.
    const result = await createReviewProofLauncher(prepareReviewProofSandbox)({ workspace, sourcePath, nodeArguments: ['--disable-sigusr1', '--experimental-strip-types', '/run/proof/proof.ts'], timeoutMilliseconds: 5000 })
    expect(result._tag, JSON.stringify(result)).toBe('Exited')
    if (result._tag === 'Exited') {
      expect(result.exitCode, result.output).toBe(0)
      expect(result.output).toContain('OS boundaries held')
      expect(result.output).not.toContain('fake-controller-credential')
      expect(result.output).not.toContain('fake-socket-credential')
    }
    expect(connections).toBe(0)
  }
  finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

it('terminates the whole Bubblewrap group when an infinite proof reaches its deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proof-deadline-'))
  try {
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const sourcePath = join(root, 'source.ts')
    await writeFile(sourcePath, 'console.log("started"); while (true) {}', { mode: 0o400 })
    const result = await createReviewProofLauncher(prepareReviewProofSandbox)({ workspace, sourcePath, nodeArguments: ['--disable-sigusr1', '--experimental-strip-types', '--permission', '--allow-fs-read=/run/proof/proof.ts', '/run/proof/proof.ts'], timeoutMilliseconds: 300 })
    expect(result).toEqual({ _tag: 'TimedOut', output: 'started\n' })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}, 5000)
