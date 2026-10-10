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

interface CliRun {
  code: number
  stdout: string
  stderr: string
}

function runControlCli(args: string[]): Promise<CliRun> {
  return executeFile(process.execPath, ['--experimental-strip-types', 'src/cli.ts', ...args], { cwd: join(import.meta.dirname, '..') })
    .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }))
    .catch((error: NodeJS.ErrnoException & { stdout: string, stderr: string }) => ({
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout,
      stderr: error.stderr,
    }))
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
})

describe('harlan GitHub Agent control CLI', () => {
  it.each(['valid', 'invalid', 'current'])('reruns triage only for an exact Issue Revision: %s', async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'harlan-triage-cli-'))
    temporaryDirectories.push(directory)
    const passwordFile = join(directory, 'password')
    await writeFile(passwordFile, 'test-password-with-at-least-32-bytes\n', { mode: 0o600 })
    const revisionId = mode === 'invalid' ? 'latest' : 'a'.repeat(64)
    const requests: unknown[] = []
    const receipt = { _tag: 'Queued', taskId: 'b'.repeat(64) }
    const server = createServer(async (request, response) => {
      if (request.method === 'GET') {
        requests.push({ path: request.url })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ revisionId, dismissed: false }))
        return
      }
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push({ path: request.url, body: JSON.parse(body) })
      response.setHeader('content-type', 'application/json')
      response.statusCode = 202
      response.end(JSON.stringify(receipt))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const result = await runControlCli(['control', 'rerun-issue', '--repository', 'harlan-zw/example', '--number', '12', ...(mode === 'current' ? [] : ['--revision', revisionId]), '--url', `http://127.0.0.1:${address.port}`, '--password-file', passwordFile])
      .finally(() => new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))))
    expect(result.code).toBe(mode === 'invalid' ? 1 : 0)
    if (mode === 'invalid') {
      expect(JSON.parse(result.stderr)._tag).toBe('InvalidIssueTarget')
      expect(requests).toEqual([])
      return
    }
    expect(JSON.parse(result.stdout)).toEqual(receipt)
    expect(requests).toEqual([
      ...(mode === 'current' ? [{ path: '/api/items/issue-status?repository=harlan-zw%2Fexample&number=12' }] : []),
      { path: '/api/issues/rerun-triage', body: { repository: 'harlan-zw/example', issueNumber: 12, revisionId } },
    ])
  })
  it.each(['normal', 'logged-finding', 'invalid'])('cancels only supported Task identities: %s', async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'harlan-recovery-cli-'))
    temporaryDirectories.push(directory)
    const passwordFile = join(directory, 'password')
    await writeFile(passwordFile, 'test-password-with-at-least-32-bytes\n', { mode: 0o600 })
    const taskId = mode === 'normal' ? 'a'.repeat(64) : mode === 'logged-finding' ? `logged-finding:${'a'.repeat(64)}` : 'logged-finding:arbitrary'
    const requests: unknown[] = []
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push({ path: request.url, body: JSON.parse(body) })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ _tag: 'Cancelled' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const result = await runControlCli(['control', 'cancel', '--task', taskId, '--url', `http://127.0.0.1:${address.port}`, '--password-file', passwordFile])
      .finally(() => new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))))
    if (mode === 'invalid') {
      expect(result.code).toBe(1)
      expect(JSON.parse(result.stderr)._tag).toBe('InvalidTaskId')
      expect(requests).toEqual([])
      return
    }
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ _tag: 'Cancelled' })
    expect(requests).toEqual([{ path: '/api/tasks/cancel', body: { taskId } }])
  })
  it('prints one tagged JSON error and exits 1 when a Task ID is missing', async () => {
    const run = await runControlCli(['control', 'cancel'])

    expect(run.code).toBe(1)
    expect(run.stdout).toBe('')
    expect(JSON.parse(run.stderr)).toEqual({ _tag: 'MissingTaskId', message: 'Set --task to one Task ID.' })
  })

  it('prints one tagged JSON error and exits 1 when the control command is unknown', async () => {
    const run = await runControlCli(['control', 'unknown'])

    expect(run.code).toBe(1)
    expect(run.stdout).toBe('')
    expect(JSON.parse(run.stderr)).toEqual({ _tag: 'UnknownControlCommand', message: 'Select a valid control command.' })
  })

  it('forwards a leading --config to the control subcommand and exits 1 with one tagged JSON error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harlan-control-cli-'))
    temporaryDirectories.push(directory)
    const configPath = join(directory, 'missing.yml')

    const run = await runControlCli(['--config', configPath, 'control', 'status'])

    expect(run.code).toBe(1)
    expect(run.stdout).toBe('')
    const errorLines = run.stderr.split('\n').filter(line => line.trim() !== '')
    expect(errorLines).toHaveLength(1)
    const [errorLine] = errorLines
    expect(JSON.parse(errorLine ?? '')).toEqual({ _tag: 'ConfigurationFailure', message: expect.stringContaining(configPath) })
  })

  it('forwards connection options between control and the nested command and exits 1 with one tagged JSON error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harlan-control-cli-'))
    temporaryDirectories.push(directory)
    const configPath = join(directory, 'missing.yml')

    const run = await runControlCli(['control', '--config', configPath, 'status'])

    expect(run.code).toBe(1)
    expect(run.stdout).toBe('')
    const errorLines = run.stderr.split('\n').filter(line => line.trim() !== '')
    expect(errorLines).toHaveLength(1)
    const [errorLine] = errorLines
    expect(JSON.parse(errorLine ?? '')).toEqual({ _tag: 'ConfigurationFailure', message: expect.stringContaining(configPath) })
  })

  it('loads the requested configuration file when --config precedes sweep-worktrees', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harlan-control-cli-'))
    temporaryDirectories.push(directory)
    const configPath = join(directory, 'requested-missing.yml')

    const run = await runControlCli(['--config', configPath, 'sweep-worktrees', '--dry-run'])

    expect(run.code).toBe(1)
    expect(run.stderr).toContain(configPath)
    expect(run.stderr).not.toContain('harlan-github-agent.yml')
  })

  it('prints one tagged JSON error and exits 1 when the configuration file is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harlan-control-cli-'))
    temporaryDirectories.push(directory)

    const run = await runControlCli(['control', 'status', '--config', join(directory, 'missing.yml')])

    expect(run.code).toBe(1)
    expect(JSON.parse(run.stderr)).toEqual({ _tag: 'ConfigurationFailure', message: expect.any(String) })
  })

  it('prints one tagged JSON error and exits 1 when the password file is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harlan-control-cli-'))
    temporaryDirectories.push(directory)

    const run = await runControlCli([
      'control',
      'status',
      '--url',
      'http://127.0.0.1:9',
      '--password-file',
      join(directory, 'missing-dashboard-password'),
    ])

    expect(run.code).toBe(1)
    expect(JSON.parse(run.stderr)).toEqual({ _tag: 'ConfigurationFailure', message: expect.any(String) })
  })

  it('prints one tagged JSON error and exits 1 when the event stream is unknown', async () => {
    const run = await runControlCli(['control', 'events', '--stream', 'nope', '--url', 'http://127.0.0.1:9'])

    expect(run.code).toBe(1)
    expect(JSON.parse(run.stderr)).toEqual({ _tag: 'InvalidStream', message: expect.any(String) })
  })

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
