export type AgentProvider = 'codex' | 'opencode'

export type EjectedSessionNotice
  = | {
    _tag: 'Ejected'
    command: string
    itemNumber: number
    repository: string
  }
  | {
    _tag: 'EjectDelayed'
    command: string
    sessionId: string
    nextAction: string
  }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function validSession(provider: AgentProvider, sessionId: string): boolean {
  return provider === 'codex'
    ? /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(sessionId)
    : /^ses_[a-z\d]{8,}$/i.test(sessionId)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', `'\\''`)}'`
}

export function ejectSessionCommand(provider: AgentProvider, sessionId: string, host: string): string {
  const agent = provider === 'codex'
    ? ['/home/harlan/.local/bin/codex', 'resume', sessionId, '-c', 'tui.resume_cwd="session"']
    : ['/home/harlan/.local/bin/opencode', '--session', sessionId]
  const remoteCommand = agent.map(shellQuote).join(' ')
  return `ssh -t ${shellQuote(host)} ${shellQuote(remoteCommand)}`
}

export function ejectRecoveryFromError(error: unknown, host: string): EjectedSessionNotice | undefined {
  const failure = record(error)
  const response = record(failure?.data)
  const statusCode = failure?.statusCode ?? response?.statusCode
  const payload = record(response?.data)
  if (statusCode !== 503 || payload?._tag !== 'EjectDelayed')
    return undefined
  if (payload.provider !== 'codex' && payload.provider !== 'opencode')
    return undefined
  if (typeof payload.sessionId !== 'string' || !validSession(payload.provider, payload.sessionId))
    return undefined
  if (typeof payload.nextAction !== 'string' || payload.nextAction.trim().length === 0)
    return undefined
  return {
    _tag: 'EjectDelayed',
    command: ejectSessionCommand(payload.provider, payload.sessionId, host),
    sessionId: payload.sessionId,
    nextAction: payload.nextAction.trim(),
  }
}
