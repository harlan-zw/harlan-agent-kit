import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

interface BrowserConfiguration {
  entry: string
  fingerprint: string
  runtime: { _tag: 'Available' } | { _tag: 'Unavailable', reason: string }
}
interface BrowserReceipt {
  fingerprint: string
  daemonDigest: string
  executables: string[]
}

const within = (path: string, root: string) => path.startsWith(`${root}/`)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** Keep CLI inspection cheap and distinguish the install command from a browser named install. */
export function browserInvocation(args: readonly string[]): 'Inspect' | 'Install' | 'Run' {
  const separator = args.indexOf('--')
  const options = separator === -1 ? args : args.slice(0, separator)
  if (options.some(arg => arg === '--help' || arg === '-h' || arg === '--version'))
    return 'Inspect'
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--')
      return 'Run'
    if (arg === '--browser' || arg === '--timeout' || arg === '--idle-timeout') {
      index++
      continue
    }
    if (arg === '--connect' && /^(?:https?|wss?):\/\//.test(args[index + 1] ?? '')) {
      index++
      continue
    }
    if (!arg.startsWith('-'))
      return arg === 'install' ? 'Install' : 'Run'
  }
  return 'Run'
}

async function ordinaryPath(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return undefined
    throw error
  })
  if (metadata !== undefined && (metadata.isSymbolicLink() || await realpath(path) !== path))
    throw new Error('Browser setup paths must not use file aliases.')
}

async function readBounded(path: string): Promise<string> {
  await ordinaryPath(path)
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024)
    throw new Error('Browser setup metadata must use bounded regular files.')
  return readFile(path, 'utf8')
}

async function currentReceipt(path: string, config: BrowserConfiguration, home: string): Promise<boolean> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return undefined
    throw error
  })
  if (metadata === undefined)
    return false
  const text = await readBounded(path)
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch (error) {
    if (error instanceof SyntaxError)
      return false
    throw error
  }
  if (typeof value !== 'object' || value === null)
    return false
  const receipt = value as Partial<BrowserReceipt>
  if (receipt.fingerprint !== config.fingerprint || typeof receipt.daemonDigest !== 'string'
    || !Array.isArray(receipt.executables) || receipt.executables.length !== 3
    || !receipt.executables.every(path => typeof path === 'string' && within(path, join(home, '.cache/ms-playwright')))) {
    return false
  }
  for (const path of receipt.executables) {
    const canonical = await realpath(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        return undefined
      throw error
    })
    if (canonical === undefined)
      return false
    if (!within(canonical, join(home, '.cache/ms-playwright')))
      throw new Error('Browser executable aliases must stay inside the private browser cache.')
    if (!(await stat(canonical)).isFile())
      throw new Error('Browser executables must use regular files.')
    await access(canonical, constants.X_OK)
  }
  const daemon = join(home, '.dev-browser/daemon.mjs')
  const present = await lstat(daemon).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return undefined
    throw error
  })
  return present !== undefined && digest(await readBounded(daemon)) === receipt.daemonDigest
}

function setupEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = ['HOME', 'PATH', 'LANG', 'CI', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']
  return { ...Object.fromEntries(names.flatMap(name => environment[name] === undefined ? [] : [[name, environment[name]]])), PATH: `/run/agent/browser-setup:${environment.PATH ?? '/usr/bin:/bin'}` }
}

async function child(binary: string, args: string[], environment: NodeJS.ProcessEnv, mode: 'Command' | 'Setup'): Promise<number> {
  const running = spawn(binary, args, { env: environment, stdio: mode === 'Setup' ? ['ignore', process.stderr, process.stderr] : 'inherit' })
  const terminate = () => running.kill('SIGTERM')
  const interrupt = () => running.kill('SIGINT')
  process.once('SIGTERM', terminate)
  process.once('SIGINT', interrupt)
  try {
    return await new Promise<number>((resolve, reject) => {
      running.once('error', reject)
      running.once('exit', code => resolve(code ?? 1))
    })
  }
  finally {
    process.off('SIGTERM', terminate)
    process.off('SIGINT', interrupt)
  }
}

async function prepare(config: BrowserConfiguration, home: string, receiptPath: string): Promise<number> {
  for (const path of ['.dev-browser', '.dev-browser/daemon.mjs', '.dev-browser/package.json', '.cache', '.cache/ms-playwright'])
    await ordinaryPath(join(home, path))
  if (await currentReceipt(receiptPath, config, home))
    return 0
  process.stderr.write('Preparing private browser tools with Node 24.\n')
  const code = await child('/run/agent/browser-node', [config.entry, '--headless', 'install'], setupEnvironment(process.env), 'Setup')
  if (code !== 0)
    return code
  const core = join(home, '.dev-browser/node_modules/playwright-core')
  if (!within(await realpath(core), join(home, '.dev-browser/node_modules')))
    throw new Error('Playwright must stay inside the private browser package directory.')
  const manifest = JSON.parse(await readBounded(join(core, 'package.json'))) as { name?: unknown, version?: unknown }
  const installed = JSON.parse(await readBounded(join(home, '.dev-browser/package.json'))) as { name?: unknown, dependencies?: Record<string, unknown> }
  if (manifest.name !== 'playwright-core' || typeof manifest.version !== 'string'
    || installed.name !== 'dev-browser-runtime' || installed.dependencies?.['playwright-core'] !== manifest.version) {
    throw new Error('Browser setup needs a valid Playwright package manifest.')
  }
  const entry = join(core, 'lib/server/registry/index.js')
  if (!within(await realpath(entry), await realpath(core)))
    throw new Error('The Playwright registry entry must stay inside its package.')
  // This package was installed by the trusted browser installer inside the worker home.
  const require = createRequire(join(core, 'package.json'))
  const { registry } = require(entry) as { registry: { findExecutable: (name: string) => { executablePath: () => string } } }
  const executables = ['chromium', 'chromium-headless-shell', 'ffmpeg'].map(name => registry.findExecutable(name).executablePath())
  for (const path of executables) {
    if (typeof path !== 'string' || !within(await realpath(path), join(home, '.cache/ms-playwright')) || !(await stat(path)).isFile())
      throw new Error('Browser executables must stay inside the private browser cache.')
    await access(path, constants.X_OK)
  }
  const receipt: BrowserReceipt = { fingerprint: config.fingerprint, daemonDigest: digest(await readBounded(join(home, '.dev-browser/daemon.mjs'))), executables }
  const staged = `${receiptPath}.${randomUUID()}`
  try {
    await writeFile(staged, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' })
    await rename(staged, receiptPath)
  }
  finally {
    await rm(staged, { force: true })
  }
  return 0
}

async function main(): Promise<number> {
  const [configPath, mode, ...args] = process.argv.slice(2)
  if (configPath === undefined || !isAbsolute(configPath) || (mode !== 'run' && mode !== 'prepare'))
    throw new Error('Browser setup needs its trusted configuration and execution mode.')
  const value: unknown = JSON.parse(await readBounded(configPath))
  if (typeof value !== 'object' || value === null)
    throw new Error('Browser setup configuration must contain an object.')
  const config = value as BrowserConfiguration
  if (typeof config.entry !== 'string' || !isAbsolute(config.entry) || !/^[a-f0-9]{64}$/.test(config.fingerprint)
    || (config.runtime?._tag !== 'Available' && config.runtime?._tag !== 'Unavailable')) {
    throw new Error('Browser setup configuration is invalid.')
  }
  if (mode === 'run' && browserInvocation(args) === 'Inspect')
    return child('/run/agent/node', [config.entry, ...args], process.env, 'Command')
  if (config.runtime._tag === 'Unavailable')
    throw new Error(config.runtime.reason)
  const home = resolve(process.env.HOME ?? '')
  if (home !== '/home/agent')
    throw new Error('Browser setup requires the isolated Agent home.')
  const state = join(home, '.local/state/harlan-agent-kit')
  for (const path of [join(home, '.local'), join(home, '.local/state'), state])
    await ordinaryPath(path)
  await mkdir(state, { recursive: true, mode: 0o700 })
  const receipt = join(state, 'browser-bootstrap.json')
  if (mode === 'prepare')
    return prepare(config, home, receipt)
  const lock = join(state, 'browser-bootstrap.lock')
  await ordinaryPath(lock)
  const code = await child('/usr/bin/flock', ['--wait', '300', lock, '/run/agent/browser-node', '--experimental-strip-types', fileURLToPath(import.meta.url), configPath, 'prepare'], setupEnvironment(process.env), 'Setup')
  if (code !== 0 || browserInvocation(args) === 'Install')
    return code
  return child('/run/agent/node', [config.entry, ...args], process.env, 'Command')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().then((code) => {
    process.exitCode = code
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
