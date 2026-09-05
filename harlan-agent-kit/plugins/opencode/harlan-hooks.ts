// Runs the Claude Code plugin hooks inside opencode.
//
// The GitHub agent workers run as opencode sessions. Those sessions never load
// a Claude Code plugin, so none of the rules in `.claude-plugin/plugin.json`
// reach them. This plugin runs the same bash scripts over the same stdin and
// stdout contract, so one implementation serves both providers.
//
// `pnpm sync:context` installs the scripts to
// `~/.local/share/harlan-agent-kit/hooks/` and this file to
// `~/.config/opencode/plugins/harlan-hooks.ts`.
//
// This file exports one value. opencode loads every exported function in a
// plugin file as its own plugin, and calls it with the plugin input. A second
// exported function therefore runs with the wrong arguments and breaks the
// shell tool. Tests drive the default export.

import type { Plugin } from '@opencode-ai/plugin'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/** One installed hook script and the time it may take. */
interface HookEntry {
  file: string
  timeoutMilliseconds: number
}

/** What a hook decided about one tool call. */
type Decision
  = | { _tag: 'Allow' }
    | { _tag: 'Deny', reason: string }
    | { _tag: 'Rewrite', command: string }

/** The result of running one hook script. */
type HookRun
  = | { _tag: 'Ok', stdout: string }
    | { _tag: 'Err', reason: string }

interface HarlanHookOptions {
  /** Directory holding the installed hook scripts. */
  hooksDirectory: string
  /** Directory the hooks run in, so git and `.claude/hooks.json` resolve. */
  workingDirectory: string
  /** Session id, so `merged-branch-guard.sh` can cache its GitHub lookup. */
  sessionId?: string
}

/**
 * PreToolUse Bash hooks, in the order `.claude-plugin/plugin.json` lists them.
 *
 * `pre-commit-push.sh` only prints `additionalContext`. opencode has no place
 * to put that, so the output is dropped. It stays in the chain for parity.
 */
const commandHooks: readonly HookEntry[] = [
  { file: 'pnpm-only.sh', timeoutMilliseconds: 5000 },
  { file: 'wt-only.sh', timeoutMilliseconds: 5000 },
  { file: 'pr-skill-only.sh', timeoutMilliseconds: 5000 },
  { file: 'merged-branch-guard.sh', timeoutMilliseconds: 10000 },
  { file: 'pre-commit-push.sh', timeoutMilliseconds: 5000 },
]

/** The PostToolUse hook for a file that a tool wrote. */
const fileHook: HookEntry = { file: 'eslint.sh', timeoutMilliseconds: 30000 }

/**
 * opencode names its shell tool `bash`.
 * Read from `/experimental/tool/ids` on opencode 1.18.27.
 */
const shellTools = new Set(['bash'])

/**
 * opencode file writers. `write`, `edit` and `apply_patch` are the shipped
 * ids. `patch` and `multiedit` cover builds that name them differently.
 */
const fileTools = new Set(['write', 'edit', 'apply_patch', 'patch', 'multiedit'])

const defaultHooksDirectory = join(homedir(), '.local', 'share', 'harlan-agent-kit', 'hooks')

/** Reports a hook that could not run. The tool call still goes ahead. */
function reportHookFailure(reason: string): void {
  process.stderr.write(`harlan-hooks: ${reason}\n`)
}

/** Runs one hook script over the stdin and stdout contract. */
async function runHook(
  scriptPath: string,
  input: unknown,
  entry: HookEntry,
  options: HarlanHookOptions,
): Promise<HookRun> {
  return new Promise<HookRun>((resolve) => {
    const child = spawn('bash', [scriptPath], {
      cwd: options.workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.sessionId === undefined
        ? process.env
        : { ...process.env, CLAUDE_SESSION_ID: options.sessionId },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (run: HookRun): void => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      resolve(run)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ _tag: 'Err', reason: `${entry.file} timed out after ${entry.timeoutMilliseconds}ms` })
    }, entry.timeoutMilliseconds)

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      finish({ _tag: 'Err', reason: `${entry.file} did not start: ${error.message}` })
    })
    child.on('close', (code) => {
      if (code === 0) {
        finish({ _tag: 'Ok', stdout })
        return
      }
      finish({ _tag: 'Err', reason: `${entry.file} exited ${code}: ${stderr.trim()}` })
    })
    child.stdin.on('error', (error) => {
      finish({ _tag: 'Err', reason: `${entry.file} closed stdin: ${error.message}` })
    })
    child.stdin.end(JSON.stringify(input))
  })
}

/** Reads a hook decision from its stdout. Any other output allows the call. */
function readDecision(stdout: string): Decision {
  const trimmed = stdout.trim()
  if (trimmed === '')
    return { _tag: 'Allow' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  }
  catch {
    // The contract treats unrecognised output as allow, so this is ignorable.
    return { _tag: 'Allow' }
  }
  if (typeof parsed !== 'object' || parsed === null)
    return { _tag: 'Allow' }
  const specific = (parsed as { hookSpecificOutput?: unknown }).hookSpecificOutput
  if (typeof specific !== 'object' || specific === null)
    return { _tag: 'Allow' }
  const output = specific as {
    permissionDecision?: unknown
    permissionDecisionReason?: unknown
    updatedInput?: { command?: unknown }
  }
  if (output.permissionDecision === 'deny') {
    const reason = typeof output.permissionDecisionReason === 'string'
      ? output.permissionDecisionReason
      : 'A Harlan Agent Kit hook denied this command.'
    return { _tag: 'Deny', reason }
  }
  const rewritten = output.updatedInput?.command
  if (output.permissionDecision === 'allow' && typeof rewritten === 'string')
    return { _tag: 'Rewrite', command: rewritten }
  return { _tag: 'Allow' }
}

/** Returns the first non-empty string among these keys. */
function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value !== '')
      return value
  }
  return ''
}

/**
 * Runs every PreToolUse Bash hook over one shell command.
 *
 * Returns the command to run, or a deny reason. A hook that fails to run never
 * denies. A broken enforcement layer must not stop the fleet.
 */
async function decideCommand(
  command: string,
  options: HarlanHookOptions,
): Promise<{ _tag: 'Allow', command: string } | { _tag: 'Deny', reason: string }> {
  let current = command
  for (const entry of commandHooks) {
    const run = await runHook(
      join(options.hooksDirectory, entry.file),
      { tool_input: { command: current } },
      entry,
      options,
    )
    if (run._tag === 'Err') {
      reportHookFailure(run.reason)
      continue
    }
    const decision = readDecision(run.stdout)
    if (decision._tag === 'Deny')
      return { _tag: 'Deny', reason: decision.reason }
    if (decision._tag === 'Rewrite')
      current = decision.command
  }
  return { _tag: 'Allow', command: current }
}

/** Runs the PostToolUse file hook over one written path. */
async function lintWrittenFile(filePath: string, options: HarlanHookOptions): Promise<void> {
  const run = await runHook(
    join(options.hooksDirectory, fileHook.file),
    { tool_input: { file_path: filePath } },
    fileHook,
    options,
  )
  if (run._tag === 'Err')
    reportHookFailure(run.reason)
}

/** Builds the opencode hooks over one installed hooks directory. */
function createHarlanHooks(options: HarlanHookOptions) {
  return {
    'tool.execute.before': async (input: { tool: string, sessionID?: string }, output: { args: any }) => {
      if (!shellTools.has(input.tool))
        return
      const command = typeof output.args?.command === 'string' ? output.args.command : ''
      if (command === '')
        return
      const verdict = await decideCommand(command, { ...options, sessionId: input.sessionID })
      if (verdict._tag === 'Deny') {
        // Throwing is how a plugin blocks a tool call. Verified on opencode
        // 1.18.27: the tool never runs, the session survives, and the model
        // reads this message.
        throw new Error(verdict.reason)
      }
      // opencode hands the same args object to the tool, so mutate it in place.
      // Assigning a new object to `output.args` changes nothing.
      if (verdict.command !== command)
        output.args.command = verdict.command
    },
    'tool.execute.after': async (input: { tool: string, args: any }) => {
      if (!fileTools.has(input.tool))
        return
      const args = (input.args ?? {}) as Record<string, unknown>
      const filePath = firstString(args, ['filePath', 'file_path', 'path', 'file'])
      if (filePath === '')
        return
      await lintWrittenFile(filePath, options)
    },
  }
}

export default (async ({ directory }) => createHarlanHooks({
  hooksDirectory: process.env.HARLAN_AGENT_HOOKS_DIR ?? defaultHooksDirectory,
  workingDirectory: directory,
})) satisfies Plugin
