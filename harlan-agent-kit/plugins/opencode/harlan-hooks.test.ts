// Drives the opencode plugin against the real hook scripts in ../../hooks.
//
// The plugin exports only its default, because opencode loads every exported
// function in a plugin file as a plugin. So every test goes through that.

import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import harlanHooks from './harlan-hooks.ts'

const hooksDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks')

/** A directory with no git repository, so merged-branch-guard.sh exits early. */
const workingDirectory = mkdtempSync(join(tmpdir(), 'harlan-hooks-'))

afterAll(() => rmSync(workingDirectory, { recursive: true, force: true }))

interface Hooks {
  'tool.execute.before': (input: { tool: string, sessionID?: string }, output: { args: any }) => Promise<void>
  'tool.execute.after': (input: { tool: string, sessionID?: string, args: any }, output?: { title?: string, output?: string, metadata?: any }) => Promise<void>
}

/** Loads the plugin the way opencode does, over a chosen hooks directory. */
async function loadPlugin(directory: string, hooks = hooksDirectory): Promise<Hooks> {
  process.env.HARLAN_AGENT_HOOKS_DIR = hooks
  return await (harlanHooks as any)({ directory }) as Hooks
}

/** Runs the shell hook and returns the command opencode would then run. */
async function runShellHook(command: string): Promise<string> {
  const plugin = await loadPlugin(workingDirectory)
  const args = { command }
  await plugin['tool.execute.before']({ tool: 'bash' }, { args })
  return args.command
}

/** Builds a project whose local eslint records the arguments it received. */
function projectWithRecordingEslint(): { directory: string, log: string } {
  const directory = mkdtempSync(join(tmpdir(), 'harlan-hooks-project-'))
  const log = join(directory, 'eslint.log')
  mkdirSync(join(directory, 'node_modules', '.bin'), { recursive: true })
  const binary = join(directory, 'node_modules', '.bin', 'eslint')
  writeFileSync(binary, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${log}'\n`)
  chmodSync(binary, 0o755)
  return { directory, log }
}

describe('tool.execute.before', () => {
  it('rewrites npm to pnpm', async () => {
    await expect(runShellHook('npm install --frozen-lockfile')).resolves.toBe('pnpm install --frozen-lockfile')
  })

  it('rewrites npx to pnpm dlx', async () => {
    await expect(runShellHook('npx tsx script.ts')).resolves.toBe('pnpm dlx tsx script.ts')
  })

  it('denies a raw git worktree add', async () => {
    await expect(runShellHook('git worktree add ../copy feature'))
      .rejects
      .toThrow(/Use wt, not git worktree/)
  })

  it('denies a bare gh pr create', async () => {
    await expect(runShellHook('gh pr create --fill')).rejects.toThrow(/PR skill/)
  })

  it('allows gh pr create from the PR skill', async () => {
    await expect(runShellHook('HARLAN_AGENT_PR_SKILL=1 gh pr create --fill'))
      .resolves
      .toBe('HARLAN_AGENT_PR_SKILL=1 gh pr create --fill')
  })

  it('leaves a tool that is not the shell alone', async () => {
    const plugin = await loadPlugin(workingDirectory)
    const args = { command: 'npm install' }
    await plugin['tool.execute.before']({ tool: 'read' }, { args })
    expect(args.command).toBe('npm install')
  })

  it('allows the command and reports when the hooks are missing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const plugin = await loadPlugin(workingDirectory, join(workingDirectory, 'absent'))
    const args = { command: 'npm install' }
    await plugin['tool.execute.before']({ tool: 'bash' }, { args })
    expect(args.command).toBe('npm install')
    expect(stderr.mock.calls).toHaveLength(5)
    stderr.mockRestore()
  })
})

describe('tool.execute.after', () => {
  it('lints the written file', async () => {
    const project = projectWithRecordingEslint()
    const plugin = await loadPlugin(project.directory)
    await plugin['tool.execute.after']({ tool: 'write', args: { filePath: 'src/index.ts' } })
    expect(readFileSync(project.log, 'utf8')).toMatch(/src\/index\.ts --fix/)
    rmSync(project.directory, { recursive: true, force: true })
  })

  it('ignores a tool that wrote no file', async () => {
    const project = projectWithRecordingEslint()
    const plugin = await loadPlugin(project.directory)
    await plugin['tool.execute.after']({ tool: 'bash', args: { command: 'ls' } })
    expect(() => readFileSync(project.log, 'utf8')).toThrow()
    rmSync(project.directory, { recursive: true, force: true })
  })

  it('appends a command-not-found suggestion to the shell output', async () => {
    const command = `harlan-missing-${randomUUID()}`
    const plugin = await loadPlugin(workingDirectory)
    const output = { title: 'bash', output: `bash: ${command}: command not found`, metadata: {} }
    await plugin['tool.execute.after']({ tool: 'bash', sessionID: randomUUID(), args: { command } }, output)
    expect(output.output).toContain(`\`${command}\` is not installed`)
  })

  it('leaves shell output without a known failure alone', async () => {
    const plugin = await loadPlugin(workingDirectory)
    const output = { title: 'bash', output: 'src', metadata: {} }
    await plugin['tool.execute.after']({ tool: 'bash', sessionID: randomUUID(), args: { command: 'ls' } }, output)
    expect(output.output).toBe('src')
  })
})
