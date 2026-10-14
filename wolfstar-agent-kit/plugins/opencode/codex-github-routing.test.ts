import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const manifest = JSON.parse(readFileSync(resolve(root, 'hooks/codex.json'), 'utf8')) as {
  hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] }
}

// Execute the registered Codex definitions with the documented Bash input.
function decision(command: string, key = 'command'): string | undefined {
  for (const group of manifest.hooks.PreToolUse) {
    if (!new RegExp(group.matcher).test('Bash')) continue
    for (const hook of group.hooks) {
      const result = spawnSync('bash', [hook.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/, root)], {
        input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { [key]: command } }),
        encoding: 'utf8',
      })
      if (result.status !== 0) throw new Error(result.stderr)
      if (result.stdout.trim() === '') continue
      const output = JSON.parse(result.stdout)
      if (output.hookSpecificOutput?.permissionDecision === 'deny')
        return output.hookSpecificOutput.permissionDecisionReason
    }
  }
  return undefined
}

describe('registered Codex GitHub routing', () => {
  it.each(['command', 'cmd'])('blocks ordinary-account public reads through %s input', (key) => {
    expect(decision('gh api repos/owner/public/issues', key)).toMatch(/agent-gh/)
  })

  it('allows public reads through the isolated CLI', () => {
    expect(decision('agent-gh api repos/owner/public/issues')).toBeUndefined()
  })

  it('preserves a private exception on its matching invocation only', () => {
    const privateRead = 'WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh pr view 1 --repo owner/private'
    expect(decision(privateRead)).toBeUndefined()
    expect(decision(`${privateRead}; gh api repos/owner/public/issues`)).toMatch(/agent-gh/)
  })

  it('retains the PR skill requirement for writes', () => {
    expect(decision('gh pr create --fill')).toMatch(/PR skill/)
    expect(decision('WOLFSTAR_AGENT_PR_SKILL=1 gh pr create --fill')).toBeUndefined()
  })

  it.each([
    'run watch 123',
    'run watch 123 --interval 3',
    'run watch 123 --interval=59',
    'run watch 123 -i 0',
    'run watch 123 --interval 60 --interval 3',
    'run watch 123 --interval nope',
    'run watch 123 --interval',
    'pr checks 1 --watch',
    'pr checks 1 --watch --interval 10',
  ])('rejects rapid private CI watching: %s', (command) => {
    expect(decision(`WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh ${command} --repo owner/private`)).toMatch(/60/)
  })

  it.each([
    'run watch 123 --interval 60',
    'run watch 123 --interval=120',
    'run watch 123 -i 60',
    'run watch 123 -i60',
    'run watch 123 --interval 060',
    'pr checks 1 --watch --interval 60',
    'pr checks 1',
  ])('allows bounded private CI watching: %s', (command) => {
    expect(decision(`WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh ${command} --repo owner/private`)).toBeUndefined()
  })

  it('checks watches with global repository arguments', () => {
    expect(decision('WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh --repo owner/private run watch 123')).toMatch(/60/)
    expect(
      decision('WOLFSTAR_AGENT_GITHUB_PRIVATE=owner/private gh -R owner/private run watch 123 --interval 60'),
    ).toBeUndefined()
    expect(decision('gh --repo owner/public pr view 1')).toMatch(/agent-gh/)
  })
})
