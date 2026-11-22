import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import harlanHooks from './harlan-hooks.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const fixture = mkdtempSync(join(tmpdir(), 'draft-approval-'))
const config = join(fixture, 'config')
const settings = join(config, 'harlan-agent-kit', 'email.json')
mkdirSync(join(config, 'harlan-agent-kit'), { recursive: true })

afterAll(() => rmSync(fixture, { recursive: true, force: true }))

const commands = [
  'himalaya message save -a harlanzw -f Drafts < /tmp/reply.eml',
  '  himalaya message save -a harlanzw -f Drafts < /tmp/reply.eml',
  'himalaya message\tsave -a harlanzw -f Drafts < /tmp/reply.eml',
]

// Invoke the registered provider chain. No shell command reaches a mailbox.
async function runBefore(provider: string, command: string): Promise<void> {
  if (provider === 'opencode') {
    let before: ((event: any) => Promise<void>) | undefined
    await (harlanHooks as any).setup({
      location: { directory: fixture },
      tool: { hook: async (name: string, callback: (event: any) => Promise<void>) => {
        if (name === 'execute.before')
          before = callback
      } },
    })
    if (!before)
      throw new Error('Provider did not register its shell hook')
    await before({ tool: 'shell', input: { command }, sessionID: 'draft-fixture' })
    return
  }

  const path = provider === 'codex' ? 'hooks/codex.json' : '.claude-plugin/plugin.json'
  const manifest = JSON.parse(readFileSync(join(root, path), 'utf8')) as {
    hooks: { PreToolUse: { matcher: string, hooks: { command: string }[] }[] }
  }
  for (const group of manifest.hooks.PreToolUse) {
    if (!new RegExp(group.matcher).test('Bash'))
      continue
    for (const hook of group.hooks) {
      const result = spawnSync('bash', [hook.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/, root)], {
        cwd: fixture,
        input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
        encoding: 'utf8',
      })
      if (result.status !== 0)
        throw new Error(`Hook failed: ${result.status}`)
      if (result.stdout.trim() === '')
        continue
      const output = JSON.parse(result.stdout)
      if (output.hookSpecificOutput?.permissionDecision === 'deny')
        throw new Error(output.hookSpecificOutput.permissionDecisionReason)
    }
  }
}

describe.each(['claude', 'codex', 'opencode'])('%s draft approval boundary', (provider) => {
  describe.each(commands)('%s', (command) => {
    it.each([
      ['missing', undefined],
      ['false', '{"allowZohoDrafts":false}'],
      ['invalid type', '{"allowZohoDrafts":"true"}'],
      ['invalid JSON', '{'],
      ['enabled without draft approval', '{"allowZohoDrafts":true}'],
    ])('denies every draft save with setting %s', async (_label, content) => {
      rmSync(settings, { force: true })
      if (content !== undefined)
        writeFileSync(settings, content)
      vi.stubEnv('XDG_CONFIG_HOME', config)
      vi.stubEnv('XDG_STATE_HOME', join(fixture, 'state'))
      vi.stubEnv('HARLAN_AGENT_HOOKS_DIR', join(root, 'hooks'))
      try {
        await expect(runBefore(provider, command)).rejects.toThrow(/read only/)
      }
      finally {
        vi.unstubAllEnvs()
      }
    })
  })
})
