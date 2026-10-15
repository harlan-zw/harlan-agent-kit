import type { ChildProcess } from 'node:child_process'
import type { Socket } from 'node:net'
import type { CloudflareRuntimeInputs, RuntimePaths } from './cloudflare-runtime.ts'
import { Buffer } from 'node:buffer'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { backup, DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { App } from 'octokit'
import {
  CONTAINER_DASHBOARD_ORIGIN,
  checkoutDirectories,
  controllerEnvironment,
  readRuntimeInputs,
  renderOpencodeConfig,
  renderRuntimeConfig,
  runtimePaths,
  workersAiOnlySelection,
} from './cloudflare-runtime.ts'

/**
 * The process the Cloudflare Container runs.
 *
 * It does what systemd and a person did on Hogwild: write the configuration
 * and secrets, clone every repository the App can reach, restore the journal,
 * then keep the controller running and back the journal up. The edge Worker
 * reaches the dashboard on 8080 and the webhook listener on 8081. The
 * controller itself still binds loopback only, so these two forwarders are
 * the whole surface.
 */

const execFileAsync = promisify(execFile)

/** The edge Worker answers this hostname from R2, so the Container needs no storage credential. */
const STATE_ORIGIN = 'http://state.internal'
const BACKUP_INTERVAL_MILLISECONDS = 5 * 60_000
const FORWARDS = [
  { listen: 8080, target: 3210 },
  { listen: 8081, target: 3211 },
] as const

let status = 'The controller is starting.'

function log(message: string): void {
  console.log(`[container] ${message}`)
}

async function writeSecret(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, contents, { mode: 0o600 })
  // An existing file keeps its old mode through writeFile.
  await chmod(path, 0o600)
}

async function readState(name: string): Promise<Buffer | null> {
  const response = await fetch(`${STATE_ORIGIN}/files/${name}`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Reading ${name} from R2 answered ${response.status}.`)
  return Buffer.from(await response.arrayBuffer())
}

async function writeState(name: string, body: Buffer): Promise<void> {
  const response = await fetch(`${STATE_ORIGIN}/files/${name}`, { method: 'PUT', body })
  if (!response.ok) throw new Error(`Writing ${name} to R2 answered ${response.status}.`)
}

/**
 * Signs the GitHub CLI in as the maintainer, as Hogwild's own login is.
 *
 * The token goes over stdin, never an argument, and the CLI keeps it in the
 * controller home. The sandbox mounts none of that home, and the token leaves
 * the controller's environment with the other secrets.
 */
async function loginGitHubCli(token: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--with-token'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`gh auth login failed: ${stderr.trim() || `exit ${code}`}`)),
    )
    child.stdin.end(token)
  }).catch((error: unknown) => log(error instanceof Error ? error.message : String(error)))
}

async function writeInputs(inputs: CloudflareRuntimeInputs, paths: RuntimePaths): Promise<void> {
  await writeSecret(paths.config, renderRuntimeConfig(inputs, paths))
  await writeSecret(paths.privateKey, inputs.privateKey)
  await writeSecret(paths.dashboardPassword, inputs.dashboardPassword)
  await writeSecret(paths.webhookSecret, inputs.webhookSecret)
  // The controller trusts only checkouts under these roots, and checks they exist.
  await mkdir(paths.checkoutRoot, { recursive: true })
  await mkdir(paths.sitesRoot, { recursive: true })
  await mkdir(dirname(paths.storage), { recursive: true, mode: 0o700 })

  if (inputs.githubUserToken !== null) await loginGitHubCli(inputs.githubUserToken)
  await execFileAsync('git', ['config', '--global', 'user.name', inputs.gitName])
  await execFileAsync('git', ['config', '--global', 'user.email', inputs.gitEmail])

  if (inputs.providers.codexAuth !== null) {
    // Codex rotates its refresh token and rewrites this file. The copy in R2 is
    // the newest one. The Worker deletes it when the setup page saves a new login.
    const saved = await readState('codex-auth.json')
    await writeSecret(paths.codexAuth, saved?.toString('utf8') ?? inputs.providers.codexAuth)
  }
  if (inputs.providers.zaiApiKey !== null || inputs.providers.workersAi !== null) {
    const existing = existsSync(paths.opencodeConfig) ? await readFile(paths.opencodeConfig, 'utf8') : null
    await writeSecret(paths.opencodeConfig, renderOpencodeConfig(existing, inputs.providers))
  }
}

/**
 * Builds the sandboxed worker home codex and opencode turns run in.
 *
 * It is the same provisioning a person runs once on Hogwild. Here it runs on
 * every start, after the logins above, so the worker home always holds the
 * current ones.
 */
async function provisionWorker(paths: RuntimePaths, repositoryRoot: string): Promise<void> {
  await execFileAsync(
    process.execPath,
    [
      '--experimental-strip-types',
      join(repositoryRoot, 'scripts/agent-worker.ts'),
      '--source-home',
      paths.home,
      '--worker-home',
      paths.workerHome,
      '--config',
      paths.workerProfile,
      '--codex',
      join(paths.toolsBin, 'codex'),
      '--opencode',
      join(paths.toolsBin, 'opencode'),
      '--tool-dir',
      paths.toolsBin,
      '--tool-dir',
      dirname(process.execPath),
      '--read-only',
      repositoryRoot,
    ],
    { cwd: repositoryRoot },
  )
}

function controllerRequest(
  inputs: CloudflareRuntimeInputs,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: 3210,
        method,
        path,
        headers: {
          // The controller checks Host and Origin against its own dashboard origin.
          host: new URL(CONTAINER_DASHBOARD_ORIGIN).host,
          origin: CONTAINER_DASHBOARD_ORIGIN,
          authorization: `Basic ${Buffer.from(`agent:${inputs.dashboardPassword}`).toString('base64')}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (text += chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }))
      },
    )
    request.on('error', reject)
    request.end(payload)
  })
}

/** Pins a Workers AI model when it is the only route and nobody chose a selection yet. */
async function pinWorkersAiWhenOnlyRoute(inputs: CloudflareRuntimeInputs): Promise<void> {
  const selection = workersAiOnlySelection(inputs.providers)
  if (selection === null) return
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await controllerRequest(inputs, 'GET', '/api/state').catch(() => null)
    if (state?.status === 200) {
      const current = (JSON.parse(state.body) as { agentSelection?: { _tag?: string } }).agentSelection
      if (current?._tag !== 'FollowsConfiguration') return
      const pinned = await controllerRequest(inputs, 'POST', '/api/agents/select', { _tag: 'Pinned', ...selection })
      log(
        pinned.status === 200
          ? `Pinned ${selection.model}, because Workers AI is the only Agent route.`
          : `Pinning ${selection.model} answered ${pinned.status}. Pin it from the dashboard.`,
      )
      return
    }
    await sleep(5_000)
  }
  log('The controller did not answer in time. Pin a Workers AI model from the dashboard.')
}

async function restoreJournal(paths: RuntimePaths): Promise<void> {
  if (existsSync(paths.storage)) return
  const saved = await readState('state.sqlite')
  if (saved === null) {
    log('No saved journal. The controller starts a new one.')
    return
  }
  await writeFile(paths.storage, saved, { mode: 0o600 })
  log(`Restored the journal, ${saved.byteLength} bytes.`)
}

async function backupJournal(paths: RuntimePaths): Promise<void> {
  if (existsSync(paths.storage)) {
    // The backup API copies a consistent snapshot while the controller writes.
    const snapshot = join(tmpdir(), `state-${process.pid}.sqlite`)
    const source = new DatabaseSync(paths.storage, { readOnly: true })
    try {
      await backup(source, snapshot)
    } finally {
      source.close()
    }
    await writeState('state.sqlite', await readFile(snapshot))
    await rm(snapshot, { force: true })
  }
  if (existsSync(paths.codexAuth)) await writeState('codex-auth.json', await readFile(paths.codexAuth))
}

function gitAuthEnvironment(token: string): Record<string, string> {
  // The same header form the controller uses, so the token never lands in a remote URL.
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    GIT_TERMINAL_PROMPT: '0',
  }
}

/**
 * Clones every repository the App can reach that is not cloned yet.
 *
 * The controller matches installed repositories to checkouts under `~/pkg`
 * when it starts, so a repository installed later is picked up by the next
 * controller restart, which runs this again first.
 */
async function syncCheckouts(inputs: CloudflareRuntimeInputs, paths: RuntimePaths): Promise<void> {
  const app = new App({ appId: inputs.appId, privateKey: inputs.privateKey })
  const found: { fullName: string; archived: boolean; fork: boolean; token: () => Promise<string> }[] = []
  for await (const { octokit, repository } of app.eachRepository.iterator()) {
    found.push({
      fullName: repository.full_name,
      archived: repository.archived,
      fork: repository.fork,
      token: async () => ((await octokit.auth({ type: 'installation' })) as { token: string }).token,
    })
  }
  const directories = checkoutDirectories(found, inputs.allowedOwners)
  if (directories.size === 0) log('The App reaches no allowed repository yet. Install it on a repository.')

  for (const repository of found) {
    const directory = directories.get(repository.fullName)
    if (directory === undefined) continue
    const checkout = join(paths.checkoutRoot, directory)
    if (existsSync(join(checkout, '.git'))) continue
    log(`Cloning ${repository.fullName}.`)
    try {
      await execFileAsync('git', ['clone', '--quiet', `https://github.com/${repository.fullName}.git`, checkout], {
        env: { ...process.env, ...gitAuthEnvironment(await repository.token()) },
        maxBuffer: 10 * 1024 * 1024,
      })
    } catch (error) {
      // One repository that fails to clone stays invisible. The rest still run.
      log(`Cloning ${repository.fullName} failed: ${error instanceof Error ? error.message : String(error)}`)
      await rm(checkout, { recursive: true, force: true })
    }
  }
}

/** Answers on the public port while the controller is down, so the dashboard explains instead of hanging. */
function unavailable(socket: Socket): void {
  const body = `${status}\n`
  socket.end(
    `HTTP/1.1 503 Service Unavailable\r\ncontent-type: text/plain; charset=utf-8\r\ncache-control: no-store\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  )
}

function startForwarders(): void {
  for (const { listen, target } of FORWARDS) {
    createServer((client) => {
      let connected = false
      const upstream = createConnection({ host: '127.0.0.1', port: target })
      upstream.once('connect', () => {
        connected = true
        client.pipe(upstream)
        upstream.pipe(client)
      })
      upstream.once('error', () => (connected ? client.destroy() : unavailable(client)))
      client.once('error', () => upstream.destroy())
      client.once('close', () => upstream.destroy())
    }).listen(listen, '0.0.0.0')
  }
}

async function main(): Promise<void> {
  const paths = runtimePaths(homedir())
  const repositoryRoot = process.cwd()
  startForwarders()

  const read = readRuntimeInputs(process.env)
  if (read._tag === 'Err') {
    // Stay up and say why, rather than crash and restart in a loop.
    status = `The controller cannot start:\n${read.error.join('\n')}`
    log(status)
    return
  }
  const inputs = read.value
  // The deploy script writes the commit it shipped. The image has no .git.
  const commitFile = join(repositoryRoot, '.deployed-commit')
  const deployedCommit = existsSync(commitFile) ? (await readFile(commitFile, 'utf8')).trim() : 'unknown'

  await writeInputs(inputs, paths)
  await provisionWorker(paths, repositoryRoot).catch((error: unknown) =>
    // Claude still runs without the worker. codex and opencode turns stop before any tool runs.
    log(`Provisioning the Agent worker failed: ${error instanceof Error ? error.message : String(error)}`),
  )
  await restoreJournal(paths)

  let child: ChildProcess | null = null
  let stopping = false

  const backupQuietly = async (): Promise<void> => {
    await backupJournal(paths).catch((error: unknown) => log(`Backup failed: ${String(error)}`))
  }
  const interval = setInterval(() => void backupQuietly(), BACKUP_INTERVAL_MILLISECONDS)

  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return
    stopping = true
    clearInterval(interval)
    log(`Received ${signal}. Stopping the controller.`)
    if (child !== null && child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([new Promise((resolve) => child?.once('exit', resolve)), sleep(30_000)])
    }
    await backupQuietly()
    process.exit(0)
  }
  process.on('SIGTERM', (signal) => void stop(signal))
  process.on('SIGINT', (signal) => void stop(signal))

  while (!stopping) {
    await syncCheckouts(inputs, paths).catch((error: unknown) => log(`Checkout sync failed: ${String(error)}`))
    status = 'The controller is starting.'
    const started = Date.now()
    const running = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        join(repositoryRoot, 'packages/wolfstar-github-agent/src/cli.ts'),
        '--config',
        paths.config,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...controllerEnvironment(process.env),
          WOLFSTAR_GITHUB_AGENT_UPDATES: 'deploy',
          WOLFSTAR_GITHUB_AGENT_COMMIT: deployedCommit,
        },
        stdio: 'inherit',
      },
    )
    child = running
    void pinWorkersAiWhenOnlyRoute(inputs)
    const code = await new Promise<number | null>((resolve) => running.once('exit', resolve))
    child = null
    if (stopping) return
    await backupQuietly()
    status = `The controller exited with code ${code}. It restarts in a few seconds.`
    log(status)
    // A restart from the dashboard exits cleanly and comes straight back. A
    // crash right after start waits longer, so a bad input does not spin.
    await sleep(Date.now() - started < 60_000 ? 30_000 : 2_000)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
