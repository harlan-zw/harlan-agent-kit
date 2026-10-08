import type { DesktopSession, SessionHost, SessionProject, StartSessionRequest } from '../../../src/session-protocol.ts'
import { randomUUID } from 'node:crypto'
import { createError } from 'h3'

const projects: SessionProject[] = [
  { id: 'pkg/nuxt-seo', name: 'nuxt-seo', path: '/home/harlan/pkg/nuxt-seo', kind: 'pkg' },
  { id: 'pkg/unhead', name: 'unhead', path: '/home/harlan/pkg/unhead', kind: 'pkg' },
  { id: 'sites/nuxtseo.com', name: 'nuxtseo.com', path: '/home/harlan/sites/nuxtseo.com', kind: 'sites' },
]
const now = (): string => new Date().toISOString()
const hostProjects: Record<SessionHost, SessionProject[]> = { desktop: projects, hogwild: projects.map(project => ({ ...project, path: project.path.replace('/home/harlan/', '/home/agent/') })) }
const sessions: DesktopSession[] = [{
  id: 'demo-session',
  host: 'desktop',
  project: projects[0]!,
  provider: 'codex',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'high',
  title: 'Check sitemap route handling',
  createdAt: now(),
  updatedAt: now(),
  status: 'idle',
  workspacePath: '/home/harlan/pkg/nuxt-seo.agent-sitemap',
  providerSessionId: 'demo-provider',
  messages: [{ id: 'demo-message', role: 'user', text: 'Check sitemap handling for routes with trailing slashes.', createdAt: new Date(Date.now() - 60_000).toISOString() }],
  events: [
    { seq: 1, turnId: 'demo-turn', createdAt: new Date(Date.now() - 45_000).toISOString(), event: { _tag: 'CommandStarted', command: 'pnpm test sitemap' } },
    { seq: 2, turnId: 'demo-turn', createdAt: new Date(Date.now() - 40_000).toISOString(), event: { _tag: 'CommandCompleted', command: 'pnpm test sitemap', output: '12 tests passed.\nDuration: 0.84s', exitCode: 0 } },
    { seq: 3, turnId: 'demo-turn', createdAt: now(), event: { _tag: 'Message', text: '## Sitemap checked\n\nThe sitemap preserves **trailing slashes**. All 12 route tests passed.\n\n- Generated URLs match `site.url`.\n- Nested routes keep the configured slash.\n\n```ts\nexport default defineNuxtConfig({\n  site: { trailingSlash: true }\n})\n```\n\nThe current configuration matches the generated URLs.' } },
  ],
}]
const requests = new Map<string, DesktopSession>()

export function mockSessionSnapshot() {
  const scenario = process.env.DASHBOARD_MOCK_SCENARIO
  return {
    hosts: { desktop: { connected: scenario !== 'offline', current: scenario !== 'outdated' }, hogwild: { connected: true, current: true } },
    projects: scenario === 'empty' ? { desktop: [], hogwild: [] } : hostProjects,
    sessions: scenario === 'empty' ? [] : sessions,
  }
}

export function mockSession(id: string): DesktopSession {
  const session = sessions.find(value => value.id === id)
  if (!session)
    throw createError({ statusCode: 404, statusMessage: 'Session not found.' })
  return session
}

export function mockStartSession(request: StartSessionRequest): DesktopSession {
  const previous = requests.get(request.requestId)
  if (previous)
    return previous
  const project = hostProjects[request.host].find(value => value.id === request.projectId)
  if (!project)
    throw createError({ statusCode: 400, statusMessage: 'Choose an available project.' })
  const session: DesktopSession = {
    id: randomUUID(),
    host: request.host,
    project,
    provider: request.provider,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    title: request.prompt.slice(0, 60),
    createdAt: now(),
    updatedAt: now(),
    status: 'running',
    workspacePath: `${project.path}.agent-${randomUUID().slice(0, 8)}`,
    providerSessionId: randomUUID(),
    messages: [],
    events: [],
  }
  sessions.unshift(session)
  return mockMessage(session.id, request.prompt, request.requestId)
}

export function mockMessage(id: string, prompt: string, requestId: string): DesktopSession {
  const previous = requests.get(requestId)
  if (previous)
    return previous
  const session = mockSession(id)
  session.messages.push({ id: randomUUID(), role: 'user', text: prompt, createdAt: now() })
  session.status = 'running'
  session.updatedAt = now()
  requests.set(requestId, session)
  setTimeout(() => {
    if (session.status !== 'running')
      return
    session.events.push({ seq: session.events.length + 1, turnId: requestId, createdAt: now(), event: { _tag: 'Message', text: `This is the **dashboard preview**. Your prompt reached the session API.\n\nThe session is pinned to **${session.host === 'desktop' ? 'Desktop' : 'Hogwild'}**.` } })
    session.status = 'idle'
    session.updatedAt = now()
  }, 1500)
  return session
}

export function mockStopSession(id: string): DesktopSession {
  const session = mockSession(id)
  session.status = 'stopped'
  session.updatedAt = now()
  return session
}
