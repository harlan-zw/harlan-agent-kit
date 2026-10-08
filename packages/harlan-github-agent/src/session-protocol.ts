import type { AgentEvent, AgentProviderName } from './agent-provider.ts'
import type { CodexReasoningEffort } from './types.ts'
import { AGENT_MODELS } from './agent-profile.ts'

export const SESSION_PROTOCOL = 1
export interface SessionProject { id: string, name: string, path: string, kind: 'pkg' | 'sites' }
export interface SessionMessage { id: string, role: 'user', text: string, createdAt: string }
export interface SessionEvent { seq: number, turnId: string, event: AgentEvent, createdAt: string }
export interface DesktopSession {
  id: string
  project: SessionProject
  provider: AgentProviderName
  model: string
  reasoningEffort: CodexReasoningEffort
  title: string
  createdAt: string
  updatedAt: string
  status: 'queued' | 'running' | 'stopping' | 'idle' | 'stopped' | 'interrupted' | 'failed'
  workspacePath: string | null
  providerSessionId: string | null
  messages: SessionMessage[]
  events: SessionEvent[]
}
export interface SessionTurn {
  sessionId: string
  turnId: string
  leaseToken: string
  project: SessionProject
  provider: AgentProviderName
  model: string
  reasoningEffort: CodexReasoningEffort
  prompt: string
  workspacePath: string | null
  providerSessionId: string | null
}
export interface SessionFence { instanceId: string, sessionId: string, turnId: string, leaseToken: string }
export interface StartSessionRequest { projectId: string, provider: AgentProviderName, model: string, reasoningEffort: CodexReasoningEffort, prompt: string, requestId: string }
export interface SessionMessageRequest { prompt: string, requestId: string }
export function sessionRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Session data must be an object.')
  return value as Record<string, unknown>
}
export function sessionText(value: unknown, name: string, maximum = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || value.includes('\0'))
    throw new Error(`Set a valid ${name}.`)
  return value
}
export function parseSessionMessage(value: unknown): SessionMessageRequest {
  const input = sessionRecord(value)
  return { prompt: sessionText(input.prompt, 'prompt', 100_000), requestId: sessionText(input.requestId, 'request ID') }
}
export function parseStartSession(value: unknown): StartSessionRequest {
  const input = sessionRecord(value)
  const provider = input.provider
  if (provider !== 'codex' && provider !== 'opencode')
    throw new Error('Select a supported Agent provider.')
  const model = sessionText(input.model, 'model')
  if (!(AGENT_MODELS[provider] as readonly string[]).includes(model))
    throw new Error('Select a supported Agent model.')
  const reasoningEffort = input.reasoningEffort
  if (reasoningEffort !== 'none' && reasoningEffort !== 'max' && reasoningEffort !== 'low' && reasoningEffort !== 'medium' && reasoningEffort !== 'high' && reasoningEffort !== 'xhigh')
    throw new Error('Select a supported Reasoning effort.')
  if (provider === 'codex' && reasoningEffort === 'none')
    throw new Error('Select a supported Codex Reasoning effort.')
  return { ...parseSessionMessage(input), projectId: sessionText(input.projectId, 'project ID'), provider, model, reasoningEffort }
}
export function parseSessionProjects(value: unknown): SessionProject[] {
  if (!Array.isArray(value) || value.length > 2000)
    throw new Error('Desktop projects must be a bounded list.')
  const projects = value.map((candidate): SessionProject => {
    const project = sessionRecord(candidate)
    const kind = project.kind
    const id = sessionText(project.id, 'project ID')
    const name = sessionText(project.name, 'project name')
    const path = sessionText(project.path, 'project path', 4096)
    if ((kind !== 'pkg' && kind !== 'sites') || !id.startsWith(`${kind}/`) || !path.startsWith('/') || path.split('/').includes('..'))
      throw new Error('The desktop project is invalid.')
    return { id, name, path, kind }
  })
  if (new Set(projects.map(project => project.id)).size !== projects.length)
    throw new Error('Desktop project IDs must be unique.')
  return projects
}
export function parseSessionFence(value: unknown): SessionFence {
  const input = sessionRecord(value)
  return { instanceId: sessionText(input.instanceId, 'desktop instance'), sessionId: sessionText(input.sessionId, 'Session ID'), turnId: sessionText(input.turnId, 'turn ID'), leaseToken: sessionText(input.leaseToken, 'lease token') }
}
