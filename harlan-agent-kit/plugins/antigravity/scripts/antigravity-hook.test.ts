import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { runAntigravityHook } from './antigravity-hook.ts'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const hooksDirectory = join(pluginRoot, 'hooks')
const manifest = join(pluginRoot, '.claude-plugin', 'plugin.json')

function manifestCommandHooks(): string[] {
  const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
    hooks: { PreToolUse: { matcher: string, hooks: { command: string }[] }[] }
  }
  return parsed.hooks.PreToolUse
    .filter(group => group.matcher.split('|').includes('Bash'))
    .flatMap(group => group.hooks.map(hook => hook.command.split('/').pop() ?? ''))
}

function manifestWithoutScripts(): string {
  const root = mkdtempSync(join(tmpdir(), 'harlan-agy-manifest-'))
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  copyFileSync(manifest, join(root, '.claude-plugin', 'plugin.json'))
  return join(root, 'hooks')
}

const workingDirectory = mkdtempSync(join(tmpdir(), 'harlan-agy-hooks-'))
const stateDirectory = mkdtempSync(join(tmpdir(), 'harlan-agy-state-'))
process.env.XDG_STATE_HOME = stateDirectory
const hitLog = join(stateDirectory, 'harlan-agent-kit', 'hook-hits.jsonl')

afterAll(() => {
  rmSync(workingDirectory, { recursive: true, force: true })
  rmSync(stateDirectory, { recursive: true, force: true })
})

function runCommandHook(command: string, hooks = hooksDirectory) {
  return runAntigravityHook({
    hookEventName: 'PreToolUse',
    conversationId: 'agy-test-session',
    cwd: workingDirectory,
    toolCall: { id: randomUUID(), name: 'run_command', args: { CommandLine: command } },
  }, hooks)
}

function projectWithRecordingEslint(): { directory: string, log: string } {
  const directory = mkdtempSync(join(tmpdir(), 'harlan-agy-project-'))
  const log = join(directory, 'eslint.log')
  mkdirSync(join(directory, 'node_modules', '.bin'), { recursive: true })
  const binary = join(directory, 'node_modules', '.bin', 'eslint')
  writeFileSync(binary, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${log}'\n`)
  chmodSync(binary, 0o755)
  return { directory, log }
}

describe('preToolUse', () => {
  it('rewrites npm and npx to pnpm', async () => {
    await expect(runCommandHook('npm install --frozen-lockfile')).resolves.toEqual({
      decision: 'allow',
      overwrite: { CommandLine: 'pnpm install --frozen-lockfile' },
    })
    await expect(runCommandHook('npx tsx script.ts')).resolves.toEqual({
      decision: 'allow',
      overwrite: { CommandLine: 'pnpm dlx tsx script.ts' },
    })
  })

  it('denies raw git worktree add', async () => {
    await expect(runCommandHook('git worktree add ../copy feature')).resolves.toEqual({
      decision: 'deny',
      reason: expect.stringMatching(/Use wt, not git worktree/),
    })
  })

  it('gates gh pr create behind HARLAN_AGENT_PR_SKILL=1 and body validation', async () => {
    const validBody = '### ❓ Type of change\n\n- [x] 🐞 Bug fix\n\n### 📚 Description\n\nFixes x.\n\n> 🤖 AI disclosure: [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) modified this description. [My AI open-source policy](https://harlanzw.com/blog/ai-in-open-source).'
    await expect(runCommandHook('gh pr create --fill')).resolves.toEqual({
      decision: 'deny',
      reason: expect.stringMatching(/PR skill/),
    })
    await expect(runCommandHook('HARLAN_AGENT_PR_SKILL=1 gh pr create --title "fix: x" --body "missing disclosure"')).resolves.toEqual({
      decision: 'deny',
      reason: expect.stringMatching(/AI disclosure/),
    })
    await expect(runCommandHook(`HARLAN_AGENT_PR_SKILL=1 gh pr create --title "fix: x" --body "${validBody}"`)).resolves.toEqual({
      decision: 'allow',
    })
  })

  it('routes public GitHub reads to agent-gh and blocks mail writes', async () => {
    await expect(runCommandHook('gh pr view 1 --repo owner/public')).resolves.toEqual({
      decision: 'deny',
      reason: expect.stringMatching(/agent-gh/),
    })
    await expect(runCommandHook('himalaya message delete 12')).resolves.toEqual({
      decision: 'deny',
      reason: expect.stringMatching(/read only/),
    })
  })

  it('logs hits under the antigravity surface even when PLUGIN_ROOT is set', async () => {
    rmSync(hitLog, { force: true })
    vi.stubEnv('PLUGIN_ROOT', '/plugin')
    await expect(runCommandHook('git worktree add ../copy feature')).resolves.toEqual(
      expect.objectContaining({ decision: 'deny' }),
    )
    vi.unstubAllEnvs()
    const lines = readFileSync(hitLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(lines).toEqual([expect.objectContaining({ hook: 'wt-only.sh', decision: 'deny', surface: 'antigravity' })])
  })

  it('allows non-shell tools and clean commands without logging', async () => {
    rmSync(hitLog, { force: true })
    await expect(runAntigravityHook({
      hookEventName: 'PreToolUse',
      cwd: workingDirectory,
      toolCall: { id: 'call-2', name: 'read_file', args: { Path: '/tmp/a' } },
    }, hooksDirectory)).resolves.toEqual({ decision: 'allow' })
    await expect(runCommandHook('ls')).resolves.toEqual({ decision: 'allow' })
    expect(() => readFileSync(hitLog, 'utf8')).toThrow()
  })

  it('runs every PreToolUse Bash hook and allows when scripts are missing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const missing = manifestWithoutScripts()
    await expect(runCommandHook('npm install', missing)).resolves.toEqual({ decision: 'allow' })
    expect(stderr.mock.calls).toHaveLength(manifestCommandHooks().length)
    stderr.mockRestore()
    rmSync(dirname(missing), { recursive: true, force: true })
  })

  it('allows and reports when the manifest is missing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await expect(runCommandHook('npm install', join(workingDirectory, 'absent'))).resolves.toEqual({ decision: 'allow' })
    expect(stderr.mock.calls).toHaveLength(1)
    expect(String(stderr.mock.calls[0][0])).toContain('no hook manifest at')
    stderr.mockRestore()
  })
})

describe('postToolUse and sessionStart', () => {
  it('lints edited and written files', async () => {
    const project = projectWithRecordingEslint()
    await expect(runAntigravityHook({
      hookEventName: 'PostToolUse',
      cwd: project.directory,
      toolCall: { id: 'call-3', name: 'write_file', args: { Path: 'src/index.ts' } },
    }, hooksDirectory)).resolves.toEqual({})
    await expect(runAntigravityHook({
      hookEventName: 'PostToolUse',
      cwd: project.directory,
      toolCall: { id: 'call-4', name: 'edit_file', args: { Path: 'src/other.ts' } },
    }, hooksDirectory)).resolves.toEqual({})
    const logged = readFileSync(project.log, 'utf8')
    expect(logged).toMatch(/src\/index\.ts --fix/)
    expect(logged).toMatch(/src\/other\.ts --fix/)
    rmSync(project.directory, { recursive: true, force: true })
  })

  it('injects project context on SessionStart without ANSI codes', async () => {
    const project = mkdtempSync(join(tmpdir(), 'harlan-agy-session-'))
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'demo-app' }))
    writeFileSync(join(project, 'nuxt.config.ts'), 'export default {}')
    const result = await runAntigravityHook({
      hookEventName: 'SessionStart',
      conversationId: 'agy-session-start',
      cwd: project,
    }, hooksDirectory)
    expect(result).toEqual({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: expect.stringContaining('Nuxt App: demo-app'),
          },
        },
      ],
    })
    rmSync(project, { recursive: true, force: true })
  })
})
