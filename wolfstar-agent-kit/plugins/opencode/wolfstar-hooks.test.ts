// Drives the opencode plugin against the real hook scripts in ../../hooks.
//
// The plugin exports only its default, because opencode loads every exported
// function in a plugin file as a plugin. So every test goes through that.

import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import wolfstarHooks from './wolfstar-hooks.ts'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const hooksDirectory = join(pluginRoot, 'hooks')
const manifest = join(pluginRoot, '.claude-plugin', 'plugin.json')

/** Every PreToolUse Bash hook the manifest registers, in order. */
function manifestCommandHooks(): string[] {
  const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
    hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] }
  }
  return parsed.hooks.PreToolUse.filter((group) => group.matcher.split('|').includes('Bash')).flatMap((group) =>
    group.hooks.map((hook) => hook.command.split('/').pop() ?? ''),
  )
}

/** A hooks directory that holds the manifest but no hook scripts. */
function manifestWithoutScripts(): string {
  const root = mkdtempSync(join(tmpdir(), 'wolfstar-hooks-manifest-'))
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  copyFileSync(manifest, join(root, '.claude-plugin', 'plugin.json'))
  return join(root, 'hooks')
}

/** A directory with no git repository, so merged-branch-guard.sh exits early. */
const workingDirectory = mkdtempSync(join(tmpdir(), 'wolfstar-hooks-'))

afterAll(() => rmSync(workingDirectory, { recursive: true, force: true }))

interface Hooks {
  'tool.execute.before': (input: { tool: string; sessionID?: string }, output: { args: any }) => Promise<void>
  'tool.execute.after': (
    input: { tool: string; sessionID?: string; args: any },
    output?: { title?: string; output?: string; metadata?: any },
  ) => Promise<void>
}

/** Loads the plugin the way opencode does, over a chosen hooks directory. */
async function loadPlugin(directory: string, hooks = hooksDirectory): Promise<Hooks> {
  process.env.WOLFSTAR_AGENT_HOOKS_DIR = hooks
  return (await (wolfstarHooks as any)({ directory })) as Hooks
}

/** Runs the shell hook and returns the command opencode would then run. */
async function runShellHook(command: string): Promise<string> {
  const plugin = await loadPlugin(workingDirectory)
  const args = { command }
  await plugin['tool.execute.before']({ tool: 'bash' }, { args })
  return args.command
}

/** Builds a project whose local oxlint records the arguments it received. */
function projectWithRecordingOxlint(): { directory: string; log: string } {
  const directory = mkdtempSync(join(tmpdir(), 'wolfstar-hooks-project-'))
  const log = join(directory, 'oxlint.log')
  mkdirSync(join(directory, 'node_modules', '.bin'), { recursive: true })
  const binary = join(directory, 'node_modules', '.bin', 'oxlint')
  writeFileSync(binary, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${log}'\n`)
  chmodSync(binary, 0o755)
  return { directory, log }
}

describe('tool.execute.before', () => {
  it.each([
    'WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh run watch 123 --repo owner/private',
    'WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh -R owner/private run watch 123 -i 3',
    'WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh pr checks 1 --watch --repo owner/private',
  ])('blocks rapid private CI watches: %s', async (command) => {
    await expect(runShellHook(command)).rejects.toThrow(/60/)
  })

  it.each([
    'gh api repos/owner/public/issues',
    'gh api "repos/owner/public/issues"',
    '"/usr/bin/gh" api repos/owner/public/issues',
    "bash -c 'gh api repos/owner/public/issues'",
    'for number in 1 2; do gh pr view "$number" --repo owner/public; done',
    '/usr/bin/gh api repos/owner/public/issues',
    'gh pr view 1 --repo owner/public',
    'env FOO=1 timeout 30 gh run list --repo owner/public',
    'env -u GH_TOKEN /usr/bin/gh api repos/owner/public/issues',
    'gh pr view 1 --repo owner/private WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private',
    'WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh pr view 1 --repo owner/private; gh api repos/owner/public/issues',
    'WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh pr view 1 --repo owner/public',
    'WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh pr view 1 --repo owner/private --repo owner/public',
    'WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh api repos/owner/public -f api repos/owner/private/issues',
    'gh api graphql -f query=query',
  ])('routes GitHub reads through the public CLI: %s', async (command) => {
    await expect(runShellHook(command)).rejects.toThrow(/agent-gh/)
  })

  it.each([
    'agent-gh api repos/owner/public/issues',
    'WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh pr view 1 --repo owner/private',
    'WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh api repos/owner/private/actions/runs',
    'WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh api /repos/owner/private/actions/runs',
    'WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh pr view 1 --repo=owner/private',
    'WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh pr view 1 --repo "owner/private"',
    'WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh -R owner/private run watch 123 --interval 60',
    'WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh pr checks 1 --watch --repo owner/private --interval 60',
    'gh api user --jq .login',
    'gh auth status',
    'gh api repos/owner/public/issues/1 -X PATCH --input body.json',
    'printf "gh api repos/owner/public/issues"',
    'printf "example; gh api repos/owner/public/issues"',
    "cat <<'EOF'\ngh api repos/owner/public/issues\nEOF",
  ])('preserves deliberate GitHub access and command examples: %s', async (command) => {
    await expect(runShellHook(command)).resolves.toBe(command)
  })

  it('rewrites npm to pnpm', async () => {
    await expect(runShellHook('npm install --frozen-lockfile')).resolves.toBe('pnpm install --frozen-lockfile')
  })

  it('rewrites npx to pnpm dlx', async () => {
    await expect(runShellHook('npx tsx script.ts')).resolves.toBe('pnpm dlx tsx script.ts')
  })

  it('denies a raw git worktree add', async () => {
    await expect(runShellHook('git worktree add ../copy feature')).rejects.toThrow(/Use wt, not git worktree/)
  })

  it('denies a bare gh pr create', async () => {
    await expect(runShellHook('gh pr create --fill')).rejects.toThrow(/PR skill/)
  })

  it('allows gh pr create from the PR skill', async () => {
    await expect(runShellHook('WOLFSTAR_AGENT_PR_SKILL=1 gh pr create --fill')).resolves.toBe(
      'WOLFSTAR_AGENT_PR_SKILL=1 gh pr create --fill',
    )
  })

  it('leaves a tool that is not the shell alone', async () => {
    const plugin = await loadPlugin(workingDirectory)
    const args = { command: 'npm install' }
    await plugin['tool.execute.before']({ tool: 'read' }, { args })
    expect(args.command).toBe('npm install')
  })

  it('denies a himalaya call that changes mail', async () => {
    await expect(runShellHook('himalaya message delete 12')).rejects.toThrow(/read only/)
  })

  it('runs every PreToolUse Bash hook the manifest registers', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const plugin = await loadPlugin(workingDirectory, manifestWithoutScripts())
    const args = { command: 'npm install' }
    await plugin['tool.execute.before']({ tool: 'bash' }, { args })
    // Every script is absent, so each one reports and none of them denies.
    expect(args.command).toBe('npm install')
    expect(stderr.mock.calls).toHaveLength(manifestCommandHooks().length)
    stderr.mockRestore()
  })

  it('allows the command and reports when the manifest is missing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const plugin = await loadPlugin(workingDirectory, join(workingDirectory, 'absent'))
    const args = { command: 'npm install' }
    await plugin['tool.execute.before']({ tool: 'bash' }, { args })
    expect(args.command).toBe('npm install')
    expect(stderr.mock.calls).toHaveLength(1)
    expect(String(stderr.mock.calls[0][0])).toContain('no hook manifest at')
    stderr.mockRestore()
  })
})

describe('tool.execute.after', () => {
  it('lints the written file', async () => {
    const project = projectWithRecordingOxlint()
    const plugin = await loadPlugin(project.directory)
    await plugin['tool.execute.after']({ tool: 'write', args: { filePath: 'src/index.ts' } })
    expect(readFileSync(project.log, 'utf8')).toMatch(/src\/index\.ts --fix/)
    rmSync(project.directory, { recursive: true, force: true })
  })

  it('ignores a tool that wrote no file', async () => {
    const project = projectWithRecordingOxlint()
    const plugin = await loadPlugin(project.directory)
    await plugin['tool.execute.after']({ tool: 'bash', args: { command: 'ls' } })
    expect(() => readFileSync(project.log, 'utf8')).toThrow()
    rmSync(project.directory, { recursive: true, force: true })
  })

  it('appends a command-not-found suggestion to the shell output', async () => {
    const command = `wolfstar-missing-${randomUUID()}`
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
