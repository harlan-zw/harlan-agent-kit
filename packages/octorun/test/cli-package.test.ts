import type { ChildProcess } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

const execute = promisify(execFile)
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const webhookSecret = 'synthetic-package-test-webhook-secret'
const actor = { id: 30, login: 'maintainer', type: 'User' }
const bot = { id: 90, login: 'octorun[bot]', type: 'Bot' }
const repository = { id: 10, full_name: 'acme/project', default_branch: 'main', archived: false, private: false }
const candidate = { path: 'src/account.ts', side: 'RIGHT', line: 2, title: 'Handle missing accounts', body: 'A missing account throws when its name is read.', evidence: 'return account.name', severity: 'high', confidence: 94 }

async function until<T>(read: () => Promise<T | null>, milliseconds = 30000): Promise<T> {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null)
      return value
    await delay(100)
  }
  throw new Error('The installed package did not reach the expected state before the deadline.')
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const timeout = globalThis.setTimeout(() => child.kill('SIGKILL'), 5000)
  await exited
  clearTimeout(timeout)
}

it('runs the production tarball from a clean home through GitHub, restart, and finding conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octorun-package-'))
  const installation = join(root, 'installation')
  const home = join(root, 'home')
  const configHome = join(root, 'config')
  const stateHome = join(root, 'state')
  const cert = join(root, 'localhost.crt')
  const key = join(root, 'localhost.key')
  await Promise.all([mkdir(installation), mkdir(home), mkdir(configHome), mkdir(stateHome)])
  const processes = new Set<ChildProcess>()
  const errors: string[] = []
  const comments: Record<string, unknown>[] = []
  const reviews: Record<string, unknown>[] = []
  const reviewComments: Record<string, unknown>[] = []
  const checkRuns: Record<string, unknown>[] = []
  const requests: string[] = []
  let providerCalls = 0
  let nextId = 100
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'])
  const https = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    const handle = async () => {
      const url = new URL(request.url!, 'https://localhost')
      const path = decodeURIComponent(url.pathname).replace(/\/$/, '')
      const method = request.method ?? 'GET'
      requests.push(`${method} ${path}`)
      const chunks: Buffer[] = []
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const input = Buffer.concat(chunks).toString('utf8')
      const body = (input ? JSON.parse(input) : {}) as Record<string, unknown>
      const send = (value: unknown, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(value))
      }
      const pull = { number: 1, title: 'Read account name', body: '', state: 'open', draft: false, changed_files: 1, updated_at: '2026-10-21T00:00:00Z', user: actor, labels: [], head: { sha: head, repo: { id: 11, full_name: 'outside/fork' } }, base: { sha: base, repo: repository } }
      if (path === '/app')
        return send({ id: 7, slug: 'octorun' })
      if (path === '/users/octorun[bot]')
        return send(bot)
      if (path === '/repos/acme/project/installation')
        return send({ id: 20 })
      if (path === '/app/installations/20/access_tokens')
        return send({ token: 'synthetic-installation-token', expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: body.permissions, repositories: [repository] })
      if (path === '/repos/acme/project')
        return send(repository)
      if (path === '/repos/acme/project/pulls/1')
        return send(pull)
      if (path === '/repos/acme/project/pulls')
        return send([pull])
      if (path === '/repos/acme/project/pulls/1/files')
        return send([{ filename: 'src/account.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,2 +1,2 @@\n export function name(account) {\n-return account?.name\n+return account.name\n' }])
      if (path === '/repos/acme/project/collaborators/maintainer/permission')
        return send({ permission: 'write', user: actor })
      if (path === '/repos/acme/project/commits/main')
        return send({ sha: base })
      if (path.includes('/contents/'))
        return send({ message: 'Not found' }, 404)
      if (path === '/v1/chat/completions') {
        providerCalls++
        const messages = body.messages as { content: string }[]
        const prompt = messages[0]!.content
        const content = prompt.includes('Answer only the question')
          ? 'The finding concerns a missing account. This answer does not change repository code.'
          : prompt.includes('Independently challenge') ? JSON.stringify({ accepted: ['correctness-0'] }) : JSON.stringify({ findings: [candidate] })
        return send({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 20 } })
      }
      if (path.endsWith(`/commits/${head}/check-runs`))
        return send({ check_runs: checkRuns })
      if (path === '/repos/acme/project/check-runs' && method === 'POST') {
        const value = { ...body, id: nextId++, app: { id: 7 }, html_url: 'https://example.invalid/check' }
        checkRuns.push(value)
        return send(value, 201)
      }
      if (/\/check-runs\/\d+$/.test(path) && method === 'PATCH') {
        const value = checkRuns.find(check => check.id === Number(path.split('/').at(-1)))!
        Object.assign(value, body)
        return send(value)
      }
      if (path === '/repos/acme/project/issues/1/comments') {
        if (method === 'GET')
          return send(comments)
        const value = { ...body, id: nextId++, user: bot, html_url: 'https://example.invalid/comment' }
        comments.push(value)
        return send(value, 201)
      }
      if (/\/issues\/comments\/\d+$/.test(path) && method === 'PATCH') {
        const value = comments.find(comment => comment.id === Number(path.split('/').at(-1)))!
        Object.assign(value, body)
        return send(value)
      }
      if (path === '/repos/acme/project/pulls/1/reviews') {
        if (method === 'GET')
          return send(reviews)
        const value = { ...body, id: nextId++, user: bot, html_url: 'https://example.invalid/review' }
        reviews.push(value)
        for (const comment of body.comments as Record<string, unknown>[]) {
          reviewComments.push({ ...comment, id: nextId++, user: bot, commit_id: head, pull_request_url: 'https://api.github.com/repos/acme/project/pulls/1', html_url: 'https://example.invalid/finding' })
        }
        return send(value, 201)
      }
      if (path === '/repos/acme/project/pulls/1/comments')
        return send(reviewComments)
      if (/\/pulls\/comments\/\d+$/.test(path)) {
        const value = reviewComments.find(comment => comment.id === Number(path.split('/').at(-1)))
        return send(value ?? { message: 'Not found' }, value ? 200 : 404)
      }
      if (/\/pulls\/1\/comments\/\d+\/replies$/.test(path) && method === 'POST') {
        const value = { ...body, id: nextId++, user: bot, in_reply_to_id: Number(path.split('/').at(-2)), html_url: 'https://example.invalid/reply' }
        reviewComments.push(value)
        return send(value, 201)
      }
      if (path === '/repos/acme/project/issues/comments' || path === '/repos/acme/project/pulls/comments')
        return send([])
      errors.push(`${method} ${path}`)
      send({ message: 'Unknown mock route' }, 404)
    }
    void handle().catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : 'Mock request failed')
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end('{}')
    })
  })
  await new Promise<void>(resolve => https.listen(0, '127.0.0.1', resolve))
  const address = https.address()
  if (!address || typeof address === 'string')
    throw new Error('Mock HTTPS server did not start.')
  const apiUrl = `https://127.0.0.1:${address.port}`
  const configPath = join(configHome, 'octorun', 'config.yaml')
  const environment: NodeJS.ProcessEnv = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, NODE_EXTRA_CA_CERTS: cert, APP_KEY: await readFile(key, 'utf8'), API_KEY: 'synthetic-provider-key', WEBHOOK_SECRET: webhookSecret, OCTORUN_GITHUB_PRIVATE_KEY: await readFile(key, 'utf8'), OCTORUN_API_KEY: 'synthetic-provider-key', OCTORUN_WEBHOOK_SECRET: webhookSecret }
  const cliPath = join(installation, 'node_modules', '@harlan-zw', 'octorun', 'dist', 'cli.mjs')
  const cli = async (...args: string[]) => {
    const result = await execute(process.execPath, [cliPath, '--json', ...args], { cwd: installation, env: environment, timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
    return JSON.parse(result.stdout) as Record<string, unknown>
  }
  const start = async () => {
    const child = spawn(process.execPath, [cliPath, '--json', 'serve'], { cwd: installation, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    processes.add(child)
    let output = ''
    let stderr = ''
    child.stdout!.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr!.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const ready = await until(async () => {
      if (child.exitCode !== null)
        throw new Error(`Installed controller exited before startup: ${stderr}`)
      const first = output.split('\n')[0]
      return first ? JSON.parse(first) as { listening: string } : null
    })
    return { child, url: ready.listening }
  }
  const webhook = async (url: string, event: string, payload: unknown, delivery = 'signed-delivery') => {
    const body = JSON.stringify(payload)
    return fetch(`${url}/webhooks/github`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}` } })
  }
  try {
    const tarball = join(root, 'octorun.tgz')
    await execute('pnpm', ['pack', '--out', tarball], { cwd: packageDirectory, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
    await writeFile(join(installation, 'package.json'), '{"private":true,"type":"module"}\n')
    await execute('pnpm', ['--ignore-workspace', 'add', '--prod', '--ignore-scripts', '--ignore-pnpmfile', '--reporter=append-only', tarball], { cwd: installation, env: { ...environment, CI: 'true' }, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
    const installedBin = await execute('pnpm', ['--ignore-workspace', 'exec', 'octorun', '--json', 'version'], { cwd: installation, env: environment, timeout: 10000 })
    expect(JSON.parse(installedBin.stdout).node).toBe(process.version)
    await cli('init', '--repository', 'acme/project', '--repository-id', '10', '--installation-id', '20', '--app-id', '7', '--model', 'test-model')
    const config = parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    Object.assign(config.github as Record<string, unknown>, { apiUrl })
    Object.assign(config.provider as Record<string, unknown>, { baseUrl: `${apiUrl}/v1` })
    config.pollIntervalMs = 0
    config.port = 0
    await writeFile(configPath, stringify(config))
    expect((await cli('config', 'validate')).valid).toBe(true)
    expect((await cli('doctor', '--online')).ready).toBe(true)
    await copyFile(join(installation, 'node_modules', '@harlan-zw', 'octorun', 'examples', 'custom-task.ts'), join(installation, 'custom-task.ts'))
    const example = await execute(process.execPath, ['--experimental-strip-types', join(installation, 'custom-task.ts')], { cwd: installation, env: environment, timeout: 10000 })
    expect(JSON.parse(example.stdout)).toMatchObject({ state: { _tag: 'Succeeded' }, output: { repository: 'example/project' } })
    const first = await start()
    const payload = { action: 'opened', repository, installation: { id: 20 }, sender: actor, pull_request: { number: 1, head: { sha: head }, base: { sha: base }, updated_at: '2026-10-21T00:00:00Z' } }
    expect((await webhook(first.url, 'pull_request', payload)).status).toBe(202)
    await stop(first.child)
    const second = await start()
    expect((await webhook(second.url, 'pull_request', payload)).status).toBe(202)
    const completed = await until(async () => {
      const status = await cli('status')
      const runs = status.runs as Record<string, unknown>[]
      const run = runs.find(value => value.workflow === 'adversarial-review')
      return run?.state === 'Succeeded' ? run : null
    })
    expect(completed.targetKey).toBe('10:pull_request:1')
    expect(reviews).toHaveLength(1)
    expect(reviewComments).toHaveLength(1)
    expect(providerCalls).toBe(3)
    const finding = reviewComments[0]!
    const question = { action: 'created', repository, installation: { id: 20 }, sender: actor, pull_request: { number: 1 }, comment: { id: 999, body: 'Why does this fail?', in_reply_to_id: finding.id, user: actor, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } }
    expect((await webhook(second.url, 'pull_request_review_comment', question, 'conversation-delivery')).status).toBe(202)
    await until(async () => reviewComments.length === 2 ? true : null)
    expect(reviewComments[1]).toMatchObject({ in_reply_to_id: finding.id, body: expect.stringContaining('missing account') })
    expect(reviews).toHaveLength(1)
    expect(providerCalls).toBe(4)
    expect(comments).toHaveLength(1)
    expect(checkRuns.every(check => check.status === 'completed')).toBe(true)
    const backup = join(root, 'backup.sqlite')
    await cli('backup', backup)
    const refused = await execute(process.execPath, [cliPath, '--json', 'restore', backup], { cwd: installation, env: environment }).then(() => false).catch(() => true)
    expect(refused).toBe(true)
    await stop(second.child)
    expect((await cli('restore', backup)).restored).toBe(true)
    expect((await cli('inspect', String(completed.id))).state).toMatchObject({ _tag: 'Succeeded' })
    expect(errors).toEqual([])
    expect(requests.some(request => request.startsWith('POST /app/installations/20/access_tokens'))).toBe(true)
  }
  finally {
    await Promise.all([...processes].map(stop))
    await new Promise<void>((resolve, reject) => https.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 180000)
