// Runs the Claude Code plugin hooks inside opencode.
//
// The GitHub agent workers run as opencode sessions. Those sessions never load
// a Claude Code plugin, so none of the rules in `.claude-plugin/plugin.json`
// reach them. This plugin runs the same bash scripts over the same stdin and
// stdout contract, so one implementation serves both providers. PreToolUse
// Bash hooks get their decisions from the hook stdout; `command-not-found.sh`
// gets its `followup_message` appended to the shell tool output.
//
// `.claude-plugin/plugin.json` is the only place a hook is registered. This
// plugin reads its chains, their order, and their timeouts from that manifest,
// so a new hook needs no edit here.
//
// `pnpm sync:context` installs the scripts to
// `~/.local/share/harlan-agent-kit/hooks/`, the manifest to
// `~/.local/share/harlan-agent-kit/.claude-plugin/plugin.json`, and this file
// to `~/.config/opencode/plugins/harlan-hooks.ts`.
//
// This file exports one value. opencode loads every exported function in a
// plugin file as its own plugin, and calls it with the plugin input. A second
// exported function therefore runs with the wrong arguments and breaks the
// shell tool. Tests drive the default export.

import type { Plugin } from '@opencode-ai/plugin'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

/**
 * The hook chains this plugin runs, read from the plugin manifest.
 *
 * `command` holds the PreToolUse Bash chain, in manifest order.
 * `pre-commit-push.sh` only prints `additionalContext`. opencode has no place
 * to put that, so the output is dropped. It stays in the chain for parity.
 *
 * `file` holds the PostToolUse Write and Edit chain.
 *
 * `shellPost` holds the PostToolUse Bash chain. Those hooks answer with a
 * `followup_message`. Claude Code shows that as a message; opencode has no
 * such contract, so the plugin appends the suggestion to the shell tool
 * output instead.
 */
interface HookChains {
  command: readonly HookEntry[]
  file: readonly HookEntry[]
  shellPost: readonly HookEntry[]
}

/** The manifest read, so a broken manifest names its own failure. */
type ChainsRead
  = | { _tag: 'Ok', chains: HookChains }
    | { _tag: 'Err', reason: string }

interface HarlanHookOptions {
  /** Directory holding the installed hook scripts. */
  hooksDirectory: string
  /** Directory the hooks run in, so git and `.claude/hooks.json` resolve. */
  workingDirectory: string
  /** The hook chains the manifest registered. */
  chains: HookChains
  /** Session id, so `merged-branch-guard.sh` can cache its GitHub lookup. */
  sessionId?: string
}

/** Claude Code hook events this plugin maps onto opencode tools. */
const preToolUse = 'PreToolUse'
const postToolUse = 'PostToolUse'

/** Claude Code tool names, as the manifest matchers spell them. */
const claudeShellTool = 'Bash'
const claudeFileTools = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** The time a hook may take when the manifest sets no timeout. */
const defaultTimeoutMilliseconds = 5000

/** No hooks at all, used when the manifest cannot be read. */
const emptyChains: HookChains = { command: [], file: [], shellPost: [] }

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

/**
 * The manifest that registers every hook.
 *
 * It sits beside the hooks in the repository and in the install, so one
 * relative path resolves both. `pnpm sync:context` copies it there.
 */
function manifestPathFor(hooksDirectory: string): string {
  return join(hooksDirectory, '..', '.claude-plugin', 'plugin.json')
}

/**
 * Reads a matcher as the tool names it lists.
 *
 * Claude Code treats a matcher as a regular expression. Every matcher in this
 * manifest is a plain name or a `|` list of names, so this reads it as a list.
 */
function matcherTools(matcher: unknown): readonly string[] {
  if (typeof matcher !== 'string')
    return []
  return matcher.split('|').map(name => name.trim()).filter(name => name !== '')
}

/** Reads one manifest hook. Anything without a command file is skipped. */
function readEntry(hook: unknown): HookEntry | undefined {
  if (typeof hook !== 'object' || hook === null)
    return undefined
  const { command, timeout } = hook as { command?: unknown, timeout?: unknown }
  if (typeof command !== 'string')
    return undefined
  // The manifest prefixes every command with `${CLAUDE_PLUGIN_ROOT}/hooks/`.
  const file = command.split('/').pop() ?? ''
  if (file === '')
    return undefined
  return {
    file,
    timeoutMilliseconds: typeof timeout === 'number' && timeout > 0 ? timeout : defaultTimeoutMilliseconds,
  }
}

/** Reads one chain: every hook of one event whose matcher names a wanted tool. */
function readChain(events: unknown, event: string, wanted: (tool: string) => boolean): HookEntry[] {
  if (typeof events !== 'object' || events === null)
    return []
  const groups = (events as Record<string, unknown>)[event]
  if (!Array.isArray(groups))
    return []
  const entries: HookEntry[] = []
  for (const group of groups) {
    if (typeof group !== 'object' || group === null)
      continue
    const { matcher, hooks } = group as { matcher?: unknown, hooks?: unknown }
    if (!matcherTools(matcher).some(wanted))
      continue
    if (!Array.isArray(hooks))
      continue
    for (const hook of hooks) {
      const entry = readEntry(hook)
      if (entry !== undefined)
        entries.push(entry)
    }
  }
  return entries
}

/**
 * Parses the manifest into the three chains, once, at plugin load.
 *
 * The manifest is the only place a hook is registered, so a hook added there
 * reaches opencode with no second edit.
 */
function readChains(manifestPath: string): ChainsRead {
  let text: string
  try {
    text = readFileSync(manifestPath, 'utf8')
  }
  catch (error) {
    return { _tag: 'Err', reason: `no hook manifest at ${manifestPath}: ${String(error)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch (error) {
    return { _tag: 'Err', reason: `the hook manifest is not valid JSON: ${String(error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null)
    return { _tag: 'Err', reason: `the hook manifest holds no object: ${manifestPath}` }
  const events = (parsed as { hooks?: unknown }).hooks
  return {
    _tag: 'Ok',
    chains: {
      command: readChain(events, preToolUse, tool => tool === claudeShellTool),
      file: readChain(events, postToolUse, tool => claudeFileTools.has(tool)),
      shellPost: readChain(events, postToolUse, tool => tool === claudeShellTool),
    },
  }
}

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

/** Reads a followup message from a PostToolUse hook stdout. Empty when absent. */
function readFollowupMessage(stdout: string): string {
  const trimmed = stdout.trim()
  if (trimmed === '')
    return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  }
  catch {
    // The contract treats unrecognised output as no message, so this is ignorable.
    return ''
  }
  if (typeof parsed !== 'object' || parsed === null)
    return ''
  const specific = (parsed as { hookSpecificOutput?: unknown }).hookSpecificOutput
  if (typeof specific !== 'object' || specific === null)
    return ''
  const message = (specific as { message?: unknown }).message
  return typeof message === 'string' ? message : ''
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
  for (const entry of options.chains.command) {
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

/** Runs the PostToolUse file hooks over one written path. */
async function lintWrittenFile(filePath: string, options: HarlanHookOptions): Promise<void> {
  for (const entry of options.chains.file) {
    const run = await runHook(
      join(options.hooksDirectory, entry.file),
      { tool_input: { file_path: filePath } },
      entry,
      options,
    )
    if (run._tag === 'Err')
      reportHookFailure(run.reason)
  }
}

/** Runs the PostToolUse shell hooks over one finished command. Returns the first suggestion. */
async function suggestForShellOutput(command: string, toolOutput: string, options: HarlanHookOptions): Promise<string> {
  for (const entry of options.chains.shellPost) {
    const run = await runHook(
      join(options.hooksDirectory, entry.file),
      { tool_input: { command }, tool_output: toolOutput },
      entry,
      options,
    )
    if (run._tag === 'Err') {
      reportHookFailure(run.reason)
      continue
    }
    const message = readFollowupMessage(run.stdout)
    if (message !== '')
      return message
  }
  return ''
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
    'tool.execute.after': async (input: { tool: string, sessionID?: string, args: any }, output: { output?: string }) => {
      if (shellTools.has(input.tool)) {
        const command = typeof input.args?.command === 'string' ? input.args.command : ''
        const toolOutput = typeof output?.output === 'string' ? output.output : ''
        if (command === '' || toolOutput === '')
          return
        const message = await suggestForShellOutput(command, toolOutput, { ...options, sessionId: input.sessionID })
        if (message !== '')
          output.output = `${toolOutput}\n\n${message}`
        return
      }
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

export default (async ({ directory }) => {
  const hooksDirectory = process.env.HARLAN_AGENT_HOOKS_DIR ?? defaultHooksDirectory
  const read = readChains(manifestPathFor(hooksDirectory))
  // A broken enforcement layer must not stop the fleet, so this reports and
  // runs no hooks. The drift check catches a missing install first.
  if (read._tag === 'Err')
    reportHookFailure(read.reason)
  return createHarlanHooks({
    hooksDirectory,
    workingDirectory: directory,
    chains: read._tag === 'Ok' ? read.chains : emptyChains,
  })
}) satisfies Plugin
