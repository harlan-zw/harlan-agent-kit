import type { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { dashboardSnapshot } from './fixtures.ts'

const executeFile = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
})

describe('harlan GitHub Agent control CLI', () => {
  it('prints machine-readable service status without starting another service', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harlan-control-cli-'))
    temporaryDirectories.push(directory)
    const passwordFile = join(directory, 'dashboard-password')
    await writeFile(passwordFile, 'test-password-with-at-least-32-bytes\n', { mode: 0o600 })
    const snapshot = dashboardSnapshot()
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/health') {
        response.end(JSON.stringify({ status: 'ready', mutationsEnabled: false, repositories: 0, issues: 0, pullRequests: 0, tasks: 0 }))
        return
      }
      if (request.url === '/api/state') {
        response.end(JSON.stringify(snapshot))
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ message: 'Not found.' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo

    const result = await executeFile(process.execPath, [
      '--experimental-strip-types',
      'src/cli.ts',
      'control',
      'status',
      '--url',
      `http://127.0.0.1:${address.port}`,
      '--password-file',
      passwordFile,
    ], { cwd: join(import.meta.dirname, '..') }).finally(() => new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))))

    expect(JSON.parse(result.stdout)).toEqual({
      health: { status: 'ready', mutationsEnabled: false, repositories: 0, issues: 0, pullRequests: 0, tasks: 0 },
      state: snapshot,
    })
    expect(result.stderr).toBe('')
  })
})
