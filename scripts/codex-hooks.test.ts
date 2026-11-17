import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

interface HookGroup { matcher?: string, hooks: { command: string }[] }
interface HookFile { hooks: { PreToolUse?: HookGroup[] } }

function read(path: string): HookFile {
  return JSON.parse(readFileSync(new URL(`../harlan-agent-kit/${path}`, import.meta.url), 'utf8')) as HookFile
}

function bashGuards(file: HookFile, matcher: string): string[] {
  return (file.hooks.PreToolUse ?? [])
    .filter(group => group.matcher === matcher)
    .flatMap(group => group.hooks.map(hook => hook.command))
}

// Codex reads its own hook file, so a guard added to the Claude manifest alone never runs in Codex.
it('runs every Claude Code Bash guard in Codex, in the same order', () => {
  expect(bashGuards(read('hooks/codex.json'), '^Bash$'))
    .toEqual(bashGuards(read('.claude-plugin/plugin.json'), 'Bash'))
})
