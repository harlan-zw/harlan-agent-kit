#!/usr/bin/env node
// Keeps the kit plugin installed for Claude Code and Codex, read from the primary checkout.
// Sync copies this file to Hogwild alone, so it imports only Node built-ins.
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const marketplace = 'harlan-agent-kit'
const pluginId = 'harlan-agent-kit@harlan-agent-kit'
const providers = ['claude', 'codex'] as const

export type Provider = typeof providers[number]
export type ProviderState
  = | { _tag: 'Absent' }
    | { _tag: 'Present', marketplaceRoot: string | undefined, plugin: 'Missing' | 'Enabled' | 'Disabled' }
export interface Step { provider: Provider, args: string[] }

/** Plans the CLI calls that leave each installed provider on the checkout's plugin. */
export function planPluginSync(checkout: string, states: Record<Provider, ProviderState>): Step[] {
  return providers.flatMap((provider): Step[] => {
    const state = states[provider]
    // A provider that is not installed needs nothing, and a disabled plugin stays the user's choice.
    if (state._tag === 'Absent' || state.plugin === 'Disabled')
      return []
    const moved = state.marketplaceRoot !== checkout
    const steps: Step[] = []
    if (moved && state.marketplaceRoot !== undefined)
      steps.push({ provider, args: ['plugin', 'marketplace', 'remove', marketplace] })
    if (moved)
      steps.push({ provider, args: ['plugin', 'marketplace', 'add', checkout] })
    // Claude Code reads a directory marketplace in place, so it needs only the install.
    if (provider === 'claude' && (moved || state.plugin === 'Missing'))
      steps.push({ provider, args: ['plugin', 'install', pluginId, '--scope', 'user'] })
    // Codex copies the plugin, so every sync refreshes the copy. Trust survives an unchanged hook.
    if (provider === 'codex')
      steps.push({ provider, args: ['plugin', 'add', pluginId] })
    return steps
  })
}

async function cli(provider: Provider, args: string[]): Promise<string> {
  const { stdout } = await exec(provider, args, { maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

async function readState(provider: Provider): Promise<ProviderState> {
  const present = await exec(provider, ['--version']).then(() => true, (error: NodeJS.ErrnoException) => {
    // A missing binary means the provider is not installed. Anything else is a real failure.
    if (error.code === 'ENOENT')
      return false
    throw error
  })
  if (!present)
    return { _tag: 'Absent' }
  if (provider === 'claude') {
    const marketplaces = JSON.parse(await cli(provider, ['plugin', 'marketplace', 'list', '--json'])) as { name: string, path?: string }[]
    const plugins = JSON.parse(await cli(provider, ['plugin', 'list', '--json'])) as { id: string, enabled: boolean, scope: string }[]
    const plugin = plugins.find(entry => entry.id === pluginId && entry.scope === 'user')
    return {
      _tag: 'Present',
      marketplaceRoot: marketplaces.find(entry => entry.name === marketplace)?.path,
      plugin: plugin === undefined ? 'Missing' : plugin.enabled ? 'Enabled' : 'Disabled',
    }
  }
  const marketplaces = JSON.parse(await cli(provider, ['plugin', 'marketplace', 'list', '--json'])) as { marketplaces: { name: string, root: string }[] }
  const plugins = JSON.parse(await cli(provider, ['plugin', 'list', '--json'])) as { installed?: { pluginId: string, enabled: boolean }[] }
  const plugin = plugins.installed?.find(entry => entry.pluginId === pluginId)
  return {
    _tag: 'Present',
    marketplaceRoot: marketplaces.marketplaces.find(entry => entry.name === marketplace)?.root,
    plugin: plugin === undefined ? 'Missing' : plugin.enabled ? 'Enabled' : 'Disabled',
  }
}

/** Fast-forwards a clean checkout on main. Any other state is left alone and reported. */
async function fastForward(checkout: string): Promise<void> {
  const git = async (args: string[]) => (await exec('git', ['-C', checkout, ...args])).stdout.trim()
  const branch = await git(['branch', '--show-current'])
  const changes = await git(['status', '--porcelain'])
  // A skipped update must not fail a service deploy, so it warns and check:context reports the drift.
  if (branch !== 'main' || changes !== '') {
    process.stderr.write(`WARN  ${checkout} did not move to origin/main: it is on ${branch || 'a detached HEAD'} or has uncommitted changes. The plugins keep reading its current files.\n`)
    return
  }
  await git(['fetch', '--quiet', 'origin', 'main'])
  await git(['merge', '--ff-only', '--quiet', 'origin/main'])
}

/**
 * Reports a missing, disabled, or misplaced install. Sync leaves a disabled plugin alone,
 * but a settings rewrite can disable it without anyone choosing to, so the check says so.
 */
export function pluginStateProblems(checkout: string, states: Record<Provider, ProviderState>): string[] {
  return providers.flatMap((provider) => {
    const state = states[provider]
    if (state._tag === 'Absent')
      return []
    if (state.plugin === 'Disabled') {
      const enable = provider === 'claude'
        ? `run: claude plugin enable ${pluginId}`
        : `set enabled = true under [plugins."${pluginId}"] in ~/.codex/config.toml`
      return [`The ${provider} kit plugin is disabled. If that was not deliberate, ${enable}`]
    }
    const problems: string[] = []
    if (state.plugin === 'Missing')
      problems.push(`The ${provider} kit plugin is not installed.`)
    if (state.marketplaceRoot !== checkout)
      problems.push(`The ${provider} kit marketplace reads ${state.marketplaceRoot ?? 'nothing'}, not ${checkout}.`)
    return problems
  })
}

/** Adds a stale Codex copy to the state problems. */
async function check(checkout: string, states: Record<Provider, ProviderState>): Promise<string[]> {
  const problems = pluginStateProblems(checkout, states)
  if (states.codex._tag === 'Present' && states.codex.plugin === 'Enabled') {
    const manifest = JSON.parse(await readFile(join(checkout, 'harlan-agent-kit/.codex-plugin/plugin.json'), 'utf8')) as { version: string }
    const cache = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'plugins/cache', marketplace, 'harlan-agent-kit', manifest.version)
    // Compare tracked files only. Test caches in the checkout are not drift.
    const tracked = (await exec('git', ['-C', checkout, 'ls-files', '-z', '--', 'harlan-agent-kit'], { maxBuffer: 16 * 1024 * 1024 })).stdout.split('\0').filter(path => path !== '')
    const stale: string[] = []
    for (const path of tracked) {
      const source = await readFile(join(checkout, path))
      const copy = await readFile(join(cache, path.slice('harlan-agent-kit/'.length))).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT')
          return undefined
        throw error
      })
      if (copy === undefined || !copy.equals(source))
        stale.push(path)
    }
    if (stale.length > 0)
      problems.push(`The Codex kit plugin copy differs from the checkout in ${stale.length} files, such as ${stale[0]}.`)
  }
  return problems
}

async function main(argv: string[]): Promise<number> {
  const checkoutIndex = argv.indexOf('--checkout')
  const checkout = checkoutIndex === -1 ? undefined : argv[checkoutIndex + 1]
  if (checkout === undefined)
    throw new Error('Pass --checkout PATH, the primary Harlan Agent Kit checkout.')
  if (argv.includes('--update-checkout'))
    await fastForward(checkout)
  const states = { claude: await readState('claude'), codex: await readState('codex') }
  if (argv.includes('--check')) {
    const problems = await check(checkout, states)
    for (const problem of problems)
      process.stdout.write(`FAIL  ${problem} Run pnpm sync:context.\n`)
    return problems.length === 0 ? 0 : 1
  }
  for (const step of planPluginSync(checkout, states))
    await cli(step.provider, step.args)
  process.stdout.write('Synced the kit plugin for Claude Code and Codex.\n')
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  process.exitCode = await main(process.argv.slice(2))
