import type { ThreadEvent } from '@openai/codex-sdk'
import type { AgentActivityItem } from './types.ts'

/** Keep the tail of a command's output: the end is where the failure is. */
const maximumOutputLines = 24
const maximumOutputCharacters = 1_600
/** Items retained per running agent. */
const defaultItemLimit = 50
/** Agents retained at once, so a missed clear cannot grow without bound. */
const defaultAgentLimit = 32

/**
 * Command output is raw stdout and stderr from a real shell, so it can carry
 * installation tokens and API keys. Redact before anything stores or renders it.
 */
const secretPatterns: Array<[RegExp, string]> = [
  [/(x-access-token:)[^@\s]+(@)/gi, '$1***$2'],
  [/\b(gh[pousr]_)[A-Za-z0-9]{16,}\b/g, '$1***'],
  [/\b(github_pat_)\w{16,}\b/g, '$1***'],
  [/\b(sk-)[\w-]{16,}\b/g, '$1***'],
  [/\b(Bearer\s+)[\w.-]{16,}\b/gi, '$1***'],
]

export function redactSecrets(text: string): string {
  return secretPatterns.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text)
}

export function truncateOutput(text: string): string {
  const lines = text.split('\n')
  const tail = lines.length > maximumOutputLines ? lines.slice(-maximumOutputLines).join('\n') : text
  return tail.length > maximumOutputCharacters ? tail.slice(-maximumOutputCharacters) : tail
}

/**
 * Maps one Codex thread event to a line of agent activity.
 * Returns undefined for events that say nothing about what the agent is doing.
 */
export function agentActivityFromEvent(event: ThreadEvent, at: string): AgentActivityItem | undefined {
  if (event.type === 'item.completed' && event.item.type === 'command_execution') {
    return {
      _tag: 'Command',
      at,
      command: redactSecrets(event.item.command),
      output: truncateOutput(redactSecrets(event.item.aggregated_output)),
      exitCode: event.item.exit_code ?? null,
    }
  }
  if (event.type === 'item.started' && event.item.type === 'command_execution') {
    return {
      _tag: 'Command',
      at,
      command: redactSecrets(event.item.command),
      output: '',
      exitCode: null,
    }
  }
  if (event.type === 'item.completed' && event.item.type === 'file_change') {
    return {
      _tag: 'FileChange',
      at,
      changes: event.item.changes.map(change => ({ path: change.path, kind: change.kind })),
    }
  }
  if (event.type === 'item.completed' && event.item.type === 'reasoning')
    return { _tag: 'Reasoning', at, text: redactSecrets(event.item.text) }
  return undefined
}

export interface AgentActivityLog {
  /** Records one item against a task, replacing an earlier line for the same command. */
  record: (taskId: string, item: AgentActivityItem) => void
  read: (taskId: string) => AgentActivityItem[]
  clear: (taskId: string) => void
}

export interface AgentActivityLogOptions {
  itemLimit?: number
  agentLimit?: number
}

/**
 * Ephemeral, in-process activity for running agents. Nothing here survives a
 * restart by design: it answers "what is this agent doing now", not "what did it do".
 */
export function createAgentActivityLog(options: AgentActivityLogOptions = {}): AgentActivityLog {
  const itemLimit = options.itemLimit ?? defaultItemLimit
  const agentLimit = options.agentLimit ?? defaultAgentLimit
  const entries = new Map<string, AgentActivityItem[]>()

  const record: AgentActivityLog['record'] = (taskId, item) => {
    const current = entries.get(taskId) ?? []
    // A command emits once on start and again on completion; keep only the finished line.
    const previous = current[current.length - 1]
    const supersedes = item._tag === 'Command'
      && previous?._tag === 'Command'
      && previous.command === item.command
      && previous.exitCode === null
    const next = supersedes ? [...current.slice(0, -1), item] : [...current, item]
    entries.delete(taskId)
    entries.set(taskId, next.slice(-itemLimit))
    if (entries.size > agentLimit) {
      const oldest = entries.keys().next()
      if (!oldest.done)
        entries.delete(oldest.value)
    }
  }

  return {
    record,
    read: taskId => entries.get(taskId) ?? [],
    clear: (taskId) => {
      entries.delete(taskId)
    },
  }
}
