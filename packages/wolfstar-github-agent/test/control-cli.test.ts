import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
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
  return executeFile(process.execPath, ['--experimental-strip-types', 'src/cli.ts', ...args], {
    cwd: join(import.meta.dirname, '..'),
  })
    .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }))
    .catch((error: NodeJS.ErrnoException & { stdout: string; stderr: string }) => ({
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout,
      stderr: error.stderr,
    }))
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('wolfstar GitHub Agent control CLI', () => {
  it.each(['Completed', 'Missing', 'Running'])('reads focused Task activity: %s', async (state) => {
    const directory = await mkdtemp(join(tmpdir(), 'wolfstar-activity-cli-'))
    temporaryDirectories.push(directory)
    const passwordFile = join(directory, 'password')
    await writeFile(passwordFile, 'test-password-with-at-least-32-bytes\n', { mode: 0o600 })
    const taskId = 'a'.repeat(64)
    const error =
      state === 'Missing'
        ? { _tag: 'TaskNotFound', taskId, message: 'The Service has no record of this Task.' }
        : { _tag: 'TaskActivityUnavailable', taskId, state, message: `This Task is ${state}.` }
    const activity = [{ _tag: 'Reasoning', at: '2026-10-13T00:00:00.000Z', text: 'Reading.' }]
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url!)
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify(state === 'Running' ? { _tag: 'Ok', value: { taskId, activity } } : { _tag: 'Err', error }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const result = await runControlCli([
      'control',
      'activity',
      '--task',
      taskId,
      '--url',
      `http://127.0.0.1:${address.port}`,
      '--password-file',
      passwordFile,
    ]).finally(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error === undefined ? resolve() : reject(error))),
        ),
    )
    expect(requests).toEqual([`/api/tasks/activity?task=${taskId}`])
    expect(result.code).toBe(state === 'Running' ? 0 : 1)
    expect(JSON.parse(state === 'Running' ? result.stdout : result.stderr)).toEqual(
      state === 'Running' ? { taskId, activity } : error,
    )
  })

  it.each(['valid', 'invalid', 'current'])('reruns triage only for an exact Issue Revision: %s', async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'wolfstar-triage-cli-'))
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const result = await runControlCli([
      'control',
      'rerun-issue',
      '--repository',
      'wolfstar-project/example',
      '--number',
      '12',
      ...(mode === 'current' ? [] : ['--revision', revisionId]),
      '--url',
      `http://127.0.0.1:${address.port}`,
      '--password-file',
      passwordFile,
    ]).finally(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error === undefined ? resolve() : reject(error))),
        ),
    )
    expect(result.code).toBe(mode === 'invalid' ? 1 : 0)
    if (mode === 'invalid') {
      expect(JSON.parse(result.stderr)._tag).toBe('InvalidIssueTarget')
      expect(requests).toEqual([])
      return
    }
    expect(JSON.parse(result.stdout)).toEqual(receipt)
    expect(requests).toEqual([
      ...(mode === 'current'
        ? [{ path: '/api/items/issue-status?repository=wolfstar-project%2Fexample&number=12' }]
        : []),
      {
        path: '/api/issues/rerun-triage',
        body: { repository: 'wolfstar-project/example', issueNumber: 12, revisionId },
      },
    ])
  })
  it.each(['normal', 'logged-finding', 'invalid'])('cancels only supported Task identities: %s', async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'wolfstar-recovery-cli-'))
    temporaryDirectories.push(directory)
    const passwordFile = join(directory, 'password')
    await writeFile(passwordFile, 'test-password-with-at-least-32-bytes\n', { mode: 0o600 })
    const taskId =
      mode === 'normal'
        ? 'a'.repeat(64)
        : mode === 'logged-finding'
          ? `logged-finding:${'a'.repeat(64)}`
          : 'logged-finding:arbitrary'
    const requests: unknown[] = []
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push({ path: request.url, body: JSON.parse(body) })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ _tag: 'Cancelled' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const result = await runControlCli([
      'control',
      'cancel',
      '--task',
      taskId,
      '--url',
      `http://127.0.0.1:${address.port}`,
      '--password-file',
      passwordFile,
    ]).finally(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error === undefined ? resolve() : reject(error))),
        ),
    )
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
    expect(JSON.parse(run.stderr)).toEqual({
      _tag: 'UnknownControlCommand',
      message: 'Select a valid control command.',
    })
  })

  it('forwards a leading --config to the control subcommand and exits 1 with one tagged JSON error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wolfstar-control-cli-'))
    temporaryDirectories.push(directory)
    const configPath = join(directory, 'missing.yml')

    const run = await runControlCli(['--config', configPath, 'control', 'status'])

    expect(run.code).toBe(1)
    expect(run.stdout).toBe('')
    const errorLines = run.stderr.split('\n').filter((line) => line.trim() !== '')
    expect(errorLines).toHaveLength(1)
    const [errorLine] = errorLines
    expect(JSON.parse(errorLine ?? '')).toEqual({
      _tag: 'ConfigurationFailure',
      message: expect.stringContaining(configPath),
    })
  })

  it('forwards connection options between control and the nested command and exits 1 with one tagged JSON error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wolfstar-control-cli-'))
    temporaryDirectories.push(directory)
    const configPath = join(directory, 'missing.yml')

    const run = await runControlCli(['control', '--config', configPath, 'status'])

    expect(run.code).toBe(1)
    expect(run.stdout).toBe('')
    const errorLines = run.stderr.split('\n').filter((line) => line.trim() !== '')
    expect(errorLines).toHaveLength(1)
    const [errorLine] = errorLines
    expect(JSON.parse(errorLine ?? '')).toEqual({
      _tag: 'ConfigurationFailure',
      message: expect.stringContaining(configPath),
    })
  })

  it('loads the requested configuration file when --config precedes sweep-worktrees', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wolfstar-control-cli-'))
    temporaryDirectories.push(directory)
    const configPath = join(directory, 'requested-missing.yml')

    const run = await runControlCli(['--config', configPath, 'sweep-worktrees', '--dry-run'])

    expect(run.code).toBe(1)
    expect(run.stderr).toContain(configPath)
    expect(run.stderr).not.toContain('wolfstar-github-agent.yml')
  })

  it('prints one tagged JSON error and exits 1 when the configuration file is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wolfstar-control-cli-'))
    temporaryDirectories.push(directory)

    const run = await runControlCli(['control', 'status', '--config', join(directory, 'missing.yml')])

    expect(run.code).toBe(1)
    expect(JSON.parse(run.stderr)).toEqual({ _tag: 'ConfigurationFailure', message: expect.any(String) })
  })

  it('prints one tagged JSON error and exits 1 when the password file is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wolfstar-control-cli-'))
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
    const directory = await mkdtemp(join(tmpdir(), 'wolfstar-control-cli-'))
    temporaryDirectories.push(directory)
    const passwordFile = join(directory, 'dashboard-password')
    await writeFile(passwordFile, 'test-password-with-at-least-32-bytes\n', { mode: 0o600 })
    const snapshot = dashboardSnapshot()
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/health') {
        response.end(
          JSON.stringify({
            status: 'ready',
            mutationsEnabled: false,
            repositories: 0,
            issues: 0,
            pullRequests: 0,
            tasks: 0,
          }),
        )
        return
      }
      if (request.url === '/api/state') {
        response.end(JSON.stringify(snapshot))
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ message: 'Not found.' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo

    const result = await executeFile(
      process.execPath,
      [
        '--experimental-strip-types',
        'src/cli.ts',
        'control',
        'status',
        '--url',
        `http://127.0.0.1:${address.port}`,
        '--password-file',
        passwordFile,
      ],
      { cwd: join(import.meta.dirname, '..') },
    ).finally(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error === undefined ? resolve() : reject(error))),
        ),
    )

    expect(JSON.parse(result.stdout)).toEqual({
      health: { status: 'ready', mutationsEnabled: false, repositories: 0, issues: 0, pullRequests: 0, tasks: 0 },
      state: snapshot,
    })
    expect(result.stderr).toBe('')
  })
})

describe('incident resolution Control CLI', () => {
  it.each([true, false])('sends evidence only after exact target validation: %s', async (valid) => {
    const directory = await mkdtemp(join(tmpdir(), 'incident-cli-'))
    temporaryDirectories.push(directory)
    const passwordFile = join(directory, 'password')
    await writeFile(passwordFile, 'test-password-with-at-least-32-bytes\n', { mode: 0o600 })
    const input = {
      incidentId: 'a'.repeat(64),
      lastSeenAt: '2026-10-12T00:00:00.000Z',
      evidence: valid ? 'Merged fix verified.' : '',
    }
    const requests: unknown[] = []
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push({ path: request.url, body: JSON.parse(body) })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ _tag: 'Resolved' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const result = await runControlCli([
      'control',
      'resolve-incident',
      '--incident',
      input.incidentId,
      '--last-seen-at',
      input.lastSeenAt,
      '--evidence',
      input.evidence,
      '--url',
      `http://127.0.0.1:${address.port}`,
      '--password-file',
      passwordFile,
    ]).finally(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error === undefined ? resolve() : reject(error))),
        ),
    )
    expect(result.code).toBe(valid ? 0 : 1)
    expect(requests).toEqual(valid ? [{ path: '/api/incidents/resolve', body: input }] : [])
    expect(JSON.parse(valid ? result.stdout : result.stderr)._tag).toBe(
      valid ? 'Resolved' : 'InvalidIncidentResolution',
    )
  })
})

it('prints one Review history object filtered to the requested head', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wolfstar-review-cli-'))
  temporaryDirectories.push(directory)
  const passwordFile = join(directory, 'password')
  await writeFile(passwordFile, 'test-password-with-at-least-32-bytes\n', { mode: 0o600 })
  const run = {
    id: 'review-a',
    repository: 'wolfstar-project/example',
    pullRequestNumber: 12,
    headSha: 'a'.repeat(40),
    outcome: { _tag: 'Ready' },
    gates: {
      merge: { _tag: 'Passed', evidence: [] },
      review: { _tag: 'Passed', evidence: [] },
      ci: { _tag: 'Passed', evidence: [] },
    },
    findings: [],
    startedAt: '2026-10-12T01:00:00Z',
    completedAt: '2026-10-12T01:01:00Z',
  }
  const requests: unknown[] = []
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ runs: [run, { ...run, id: 'review-b', headSha: 'b'.repeat(40) }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const result = await runControlCli([
    'control',
    'reviews',
    '--repository',
    run.repository,
    '--number',
    '12',
    '--head',
    run.headSha,
    '--url',
    `http://127.0.0.1:${address.port}`,
    '--password-file',
    passwordFile,
  ]).finally(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  )
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ runs: [run] })
  expect(requests).toEqual([
    {
      path: '/api/reviews?repository=wolfstar-project%2Fexample&pull_request=12',
      authorization: `Basic ${Buffer.from('agent:test-password-with-at-least-32-bytes').toString('base64')}`,
    },
  ])
})
