import { expect, it } from 'vitest'
import { createTerminalDraftStore } from '../dashboard/app/utils/terminal-draft.ts'

it('restores a phone draft when its terminal view mounts again after switching sessions', () => {
  const drafts = createTerminalDraftStore()
  const first = { id: 'first', generation: 'one' }
  drafts.forSession(first).value = 'Keep this unsent draft'
  drafts.forSession({ id: 'second', generation: 'one' }).value = 'Other project'
  expect(drafts.forSession(first).value).toBe('Keep this unsent draft')
  expect(drafts.forSession({ ...first, generation: 'two' }).value).toBe('')
  drafts.forSession(first).value = ''
  expect(drafts.forSession(first).value).toBe('')
})

it('restores drafts from the browser tab storage after recreation', () => {
  const entries = new Map<string, string>()
  const first = createTerminalDraftStore(entries)
  const session = { id: 'first', generation: 'one' }
  first.forSession(session).value = 'Preserved after reload'
  const reloaded = createTerminalDraftStore(new Map(JSON.parse(JSON.stringify([...entries]))))
  expect(reloaded.forSession(session).value).toBe('Preserved after reload')
})
