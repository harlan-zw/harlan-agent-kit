// Runs the Claude Code plugin hooks inside Antigravity.
//
// `.claude-plugin/plugin.json` is the only place a hook is registered. This
// adapter reads its chains, order, and timeouts from that manifest at runtime,
// so a new hook needs no edit here.
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** One installed hook script and the time it may take. */
interface HookEntry {
  file: string
  timeoutMs: number
}

interface HookChains {
  sessionStart: readonly HookEntry[]
  command: readonly HookEntry[]
  file: readonly HookEntry[]
  shellPost: readonly HookEntry[]
}

export interface AntigravityHookInput {
  hookEventName?: unknown
  conversationId?: unknown
  cwd?: unknown
  error?: unknown
  toolCall?: {
    id?: unknown
    name?: unknown
    args?: Record<string, unknown>
  }
}

type Decision
  = | { _tag: 'Allow' }
    | { _tag: 'Deny', reason: string }
    | { _tag: 'Rewrite', command: string }

type HookRun
  = | { _tag: 'Ok', stdout: string }
    | { _tag: 'Err', reason: string }

const DEFAULT_TIMEOUT_MS = 5000
const CLAUDE_FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
// eslint-disable-next-line no-control-regex -- strips terminal ANSI SGR codes before injecting SessionStart context
const ANSI_ESCAPE_RE = /\x1B\[[0-9;]*m/g

function defaultHooksDirectory(): string {
  return process.env.HARLAN_AGENT_HOOKS_DIR ?? join(homedir(), '.local/share/harlan-agent-kit/hooks')
}

async function parseJson<T>(raw: string): Promise<T | undefined> {
  return Promise.resolve(raw)
    .then(text => JSON.parse(text) as T)
    .catch(() => undefined)
}

function matcherTools(matcher: unknown): readonly string[] {
  if (typeof matcher !== 'string')
    return []
  return matcher.split('|').map(name => name.trim()).filter(name => name !== '')
}

function readEntry(hook: unknown): HookEntry | undefined {
  if (typeof hook !== 'object' || hook === null)
    return undefined
  const { command, timeout } = hook as { command?: unknown, timeout?: unknown }
  if (typeof command !== 'string')
    return undefined
  const file = command.split('/').pop() ?? ''
  if (file === '')
    return undefined
  return {
    file,
    timeoutMs: typeof timeout === 'number' && timeout > 0 ? timeout * 1000 : DEFAULT_TIMEOUT_MS,
  }
}

function readChain(events: unknown, event: string, wanted?: (tool: string) => boolean): HookEntry[] {
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
    if (wanted !== undefined && !matcherTools(matcher).some(wanted))
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

async function readChains(manifestPath: string): Promise<HookChains> {
  const empty: HookChains = { sessionStart: [], command: [], file: [], shellPost: [] }
  const text = await readFile(manifestPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    process.stderr.write(`harlan-hooks: no hook manifest at ${manifestPath}: ${error.message}\n`)
    return undefined
  })
  if (text === undefined)
    return empty
  const parsed = await parseJson<{ hooks?: unknown }>(text)
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
    process.stderr.write(`harlan-hooks: the hook manifest is not valid JSON: ${manifestPath}\n`)
    return empty
  }
  return {
    sessionStart: readChain(parsed.hooks, 'SessionStart'),
    command: readChain(parsed.hooks, 'PreToolUse', tool => tool === 'Bash'),
    file: readChain(parsed.hooks, 'PostToolUse', tool => CLAUDE_FILE_TOOLS.has(tool)),
    shellPost: readChain(parsed.hooks, 'PostToolUse', tool => tool === 'Bash'),
  }
}

async function runHook(
  scriptPath: string,
  stdinPayload: unknown,
  entry: HookEntry,
  cwd: string,
): Promise<HookRun> {
  return new Promise<HookRun>((resolveRun) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HARLAN_AGENT_HOOK_SURFACE: 'antigravity',
    }
    // Antigravity sets PLUGIN_ROOT on plugin hooks; remove it so hit-log.sh never infers Codex.
    delete env.PLUGIN_ROOT
    delete env.PLUGIN_DATA

    const child = spawn('bash', [scriptPath], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (run: HookRun): void => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      resolveRun(run)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ _tag: 'Err', reason: `${entry.file} timed out after ${entry.timeoutMs}ms` })
    }, entry.timeoutMs)

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
    child.stdin.end(JSON.stringify(stdinPayload))
  })
}

async function readDecision(stdout: string): Promise<Decision> {
  const trimmed = stdout.trim()
  if (trimmed === '')
    return { _tag: 'Allow' }
  const parsed = await parseJson<{ hookSpecificOutput?: unknown }>(trimmed)
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null)
    return { _tag: 'Allow' }
  const specific = parsed.hookSpecificOutput
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

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '').trim()
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString('utf8')
}

async function handlePreToolUse(
  input: AntigravityHookInput,
  chains: HookChains,
  cwd: string,
  hooksDirectory: string,
): Promise<Record<string, unknown>> {
  if (input.toolCall?.name !== 'run_command')
    return { decision: 'allow' }
  const original = typeof input.toolCall.args?.CommandLine === 'string'
    ? input.toolCall.args.CommandLine
    : ''
  if (original === '')
    return { decision: 'allow' }

  let current = original
  for (const entry of chains.command) {
    const run = await runHook(
      join(hooksDirectory, entry.file),
      {
        session_id: typeof input.conversationId === 'string' ? input.conversationId : undefined,
        tool_use_id: typeof input.toolCall.id === 'string' ? input.toolCall.id : undefined,
        cwd,
        tool_input: { command: current },
      },
      entry,
      cwd,
    )
    if (run._tag === 'Err') {
      process.stderr.write(`harlan-hooks: ${run.reason}\n`)
      continue
    }
    const decision = await readDecision(run.stdout)
    if (decision._tag === 'Deny')
      return { decision: 'deny', reason: decision.reason }
    if (decision._tag === 'Rewrite')
      current = decision.command
  }
  if (current !== original)
    return { decision: 'allow', overwrite: { CommandLine: current } }
  return { decision: 'allow' }
}

async function handlePostToolUse(
  input: AntigravityHookInput,
  chains: HookChains,
  cwd: string,
  hooksDirectory: string,
): Promise<Record<string, unknown>> {
  const toolName = input.toolCall?.name
  if (toolName === 'write_file' || toolName === 'edit_file') {
    const filePath = typeof input.toolCall?.args?.Path === 'string' ? input.toolCall.args.Path : ''
    if (filePath === '')
      return {}
    for (const entry of chains.file) {
      const run = await runHook(
        join(hooksDirectory, entry.file),
        { cwd, tool_input: { file_path: filePath } },
        entry,
        cwd,
      )
      if (run._tag === 'Err')
        process.stderr.write(`harlan-hooks: ${run.reason}\n`)
    }
    return {}
  }

  if (toolName === 'run_command' && typeof input.error === 'string' && input.error !== '') {
    const command = typeof input.toolCall?.args?.CommandLine === 'string'
      ? input.toolCall.args.CommandLine
      : ''
    for (const entry of chains.shellPost) {
      const run = await runHook(
        join(hooksDirectory, entry.file),
        {
          session_id: typeof input.conversationId === 'string' ? input.conversationId : undefined,
          hook_event_name: 'PostToolUse',
          tool_input: { command },
          error: input.error,
        },
        entry,
        cwd,
      )
      if (run._tag === 'Err')
        process.stderr.write(`harlan-hooks: ${run.reason}\n`)
    }
  }
  return {}
}

async function handleSessionStart(
  input: AntigravityHookInput,
  chains: HookChains,
  cwd: string,
  hooksDirectory: string,
): Promise<Record<string, unknown>> {
  const messages: string[] = []
  for (const entry of chains.sessionStart) {
    const run = await runHook(
      join(hooksDirectory, entry.file),
      {
        session_id: typeof input.conversationId === 'string' ? input.conversationId : undefined,
        cwd,
      },
      entry,
      cwd,
    )
    if (run._tag === 'Err') {
      process.stderr.write(`harlan-hooks: ${run.reason}\n`)
      continue
    }
    const clean = stripAnsi(run.stdout)
    if (clean !== '')
      messages.push(clean)
  }
  if (messages.length === 0)
    return {}
  return {
    injectSteps: messages.map(systemMessage => ({ systemMessage: { systemMessage } })),
  }
}

/** Runs the registered hook chain for one Antigravity lifecycle payload. */
export async function runAntigravityHook(
  input: AntigravityHookInput,
  hooksDirectory = defaultHooksDirectory(),
): Promise<Record<string, unknown>> {
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd()
  const chains = await readChains(join(hooksDirectory, '..', '.claude-plugin', 'plugin.json'))
  if (input.hookEventName === 'PreToolUse')
    return handlePreToolUse(input, chains, cwd, hooksDirectory)
  if (input.hookEventName === 'PostToolUse')
    return handlePostToolUse(input, chains, cwd, hooksDirectory)
  if (input.hookEventName === 'SessionStart')
    return handleSessionStart(input, chains, cwd, hooksDirectory)
  return {}
}

async function main(): Promise<void> {
  const raw = await readAllStdin()
  const input = await parseJson<AntigravityHookInput>(raw)
  if (input === undefined) {
    process.stdout.write('{}\n')
    return
  }
  const output = await runAntigravityHook(input)
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main()
