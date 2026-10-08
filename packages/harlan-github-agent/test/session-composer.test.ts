import { expect, it } from 'vitest'
import { parseSessionComposerStorage, sessionProjectAvailable } from '../dashboard/app/utils/session.ts'

it('recovers a new Hogwild project selection and resets malformed stored selections', () => {
  expect(parseSessionComposerStorage('{"host":"hogwild","projectId":"pkg/unhead"}')).toEqual({ host: 'hogwild', projectId: 'pkg/unhead' })
  for (const stored of ['{"host":"remote","projectId":"pkg/unhead"}', '{"host":"hogwild","projectId":42}', '{broken'])
    expect(parseSessionComposerStorage(stored)).toEqual({ host: 'desktop', projectId: '' })
})

it('rejects removed projects and projects only present on the other host', () => {
  const project = { id: 'pkg/unhead', name: 'unhead', kind: 'pkg' as const, path: '/home/agent/pkg/unhead' }
  const snapshot = { hosts: { desktop: { connected: true, current: true }, hogwild: { connected: true, current: true } }, projects: { desktop: [], hogwild: [project] }, sessions: [] }
  expect(sessionProjectAvailable(snapshot, 'hogwild', project.id)).toBe(true)
  expect(sessionProjectAvailable(snapshot, 'desktop', project.id)).toBe(false)
  expect(sessionProjectAvailable(snapshot, 'hogwild', 'pkg/removed')).toBe(false)
  expect(sessionProjectAvailable(undefined, 'hogwild', project.id)).toBe(false)
})
