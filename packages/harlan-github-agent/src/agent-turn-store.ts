import type { DatabaseSync } from 'node:sqlite'
import type { AgentProviderName, AgentTokenUsage } from './agent-provider.ts'
import type { AgentRole } from './types.ts'

type AvailableUsage = Extract<AgentTokenUsage, { _tag: 'Available' }>

/**
 * One Agent turn and the tokens it spent, whatever the turn ended in.
 *
 * `usage` is this turn alone. `sessionTotal` is the running total a provider
 * reported for its whole session, kept so the next resumed turn can subtract it.
 */
export interface AgentTurnRecord {
  id: string
  /** The Task, Review run, or Routine run the turn worked for. */
  taskId: string
  role: AgentRole
  repository: string
  itemNumber: number
  provider: AgentProviderName
  model: string
  reasoningEffort: string | null
  sessionId: string | null
  startedAt: string
  completedAt: string
  outcome: 'Answered' | 'Failed'
  usage: AgentTokenUsage
  sessionTotal: AvailableUsage | null
}

export interface AgentTurnStore {
  recordAgentTurn: (turn: AgentTurnRecord) => void
  /** The latest running total a provider reported for this session, or null when none is on record. */
  agentSessionTotal: (sessionId: string) => AvailableUsage | null
  /** Turns completed inside the range, oldest first. */
  listAgentTurns: (range: { from: string, to: string }) => AgentTurnRecord[]
}

export const agentTurnSchema = `
  CREATE TABLE IF NOT EXISTS agent_turns (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    role TEXT NOT NULL,
    repository TEXT NOT NULL,
    item_number INTEGER NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('codex', 'opencode')),
    model TEXT NOT NULL,
    reasoning_effort TEXT,
    session_id TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    outcome_tag TEXT NOT NULL CHECK (outcome_tag IN ('Answered', 'Failed')),
    usage TEXT NOT NULL CHECK (json_valid(usage)),
    session_total TEXT CHECK (session_total IS NULL OR json_valid(session_total)),
    CHECK (completed_at >= started_at)
  );
  CREATE INDEX IF NOT EXISTS agent_turns_session ON agent_turns(session_id, completed_at);
  CREATE INDEX IF NOT EXISTS agent_turns_completed ON agent_turns(completed_at);
  CREATE INDEX IF NOT EXISTS agent_turns_task ON agent_turns(task_id);
`

interface AgentTurnRow {
  id: string
  task_id: string
  role: AgentRole
  repository: string
  item_number: number
  provider: AgentProviderName
  model: string
  reasoning_effort: string | null
  session_id: string | null
  started_at: string
  completed_at: string
  outcome_tag: AgentTurnRecord['outcome']
  usage: string
  session_total: string | null
}

const usageKeys = ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'] as const

function parseUsage(value: string): AgentTokenUsage {
  const usage = JSON.parse(value) as Record<string, unknown>
  if (usage._tag === 'Unavailable')
    return { _tag: 'Unavailable' }
  if (usage._tag !== 'Available' || usageKeys.some(key => typeof usage[key] !== 'number' || !Number.isInteger(usage[key]) || (usage[key] as number) < 0))
    throw new Error('An Agent turn has invalid token usage.')
  return {
    _tag: 'Available',
    input: usage.input as number,
    cachedInput: usage.cachedInput as number,
    cacheWrite: usage.cacheWrite as number,
    output: usage.output as number,
    reasoning: usage.reasoning as number,
  }
}

function parseSessionTotal(value: string): AvailableUsage {
  const usage = parseUsage(value)
  if (usage._tag !== 'Available')
    throw new Error('An Agent session total must be available.')
  return usage
}

function turnFromRow(row: AgentTurnRow): AgentTurnRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    role: row.role,
    repository: row.repository,
    itemNumber: row.item_number,
    provider: row.provider,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    sessionId: row.session_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    outcome: row.outcome_tag,
    usage: parseUsage(row.usage),
    sessionTotal: row.session_total === null ? null : parseSessionTotal(row.session_total),
  }
}

export function createAgentTurnStore(database: DatabaseSync): AgentTurnStore {
  const insert = database.prepare(`
    INSERT INTO agent_turns (
      id, task_id, role, repository, item_number, provider, model, reasoning_effort,
      session_id, started_at, completed_at, outcome_tag, usage, session_total
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const latestTotal = database.prepare(`
    SELECT session_total FROM agent_turns
    WHERE session_id = ? AND session_total IS NOT NULL
    ORDER BY completed_at DESC, rowid DESC
    LIMIT 1
  `)
  const inRange = database.prepare(`
    SELECT * FROM agent_turns
    WHERE completed_at >= ? AND completed_at < ?
    ORDER BY completed_at, rowid
  `)
  return {
    recordAgentTurn: (turn) => {
      insert.run(
        turn.id,
        turn.taskId,
        turn.role,
        turn.repository,
        turn.itemNumber,
        turn.provider,
        turn.model,
        turn.reasoningEffort,
        turn.sessionId,
        turn.startedAt,
        turn.completedAt,
        turn.outcome,
        JSON.stringify(turn.usage),
        turn.sessionTotal === null ? null : JSON.stringify(turn.sessionTotal),
      )
    },
    agentSessionTotal: (sessionId) => {
      const row = latestTotal.get(sessionId) as { session_total: string } | undefined
      return row === undefined ? null : parseSessionTotal(row.session_total)
    },
    listAgentTurns: range => (inRange.all(range.from, range.to) as unknown as AgentTurnRow[]).map(turnFromRow),
  }
}
