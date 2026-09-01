import type { H3Event } from 'h3'
import { createError, readBody } from 'h3'
import { currentMockSnapshot, updateMock } from './mock.ts'

/**
 * Dev-only writes behind the Watching page. Each one mirrors the controller's
 * own validation and 404, then mutates the mock so the next snapshot shows it.
 */
const repositoryPattern = /^[^/]+\/[^/]+$/

async function repositoryFrom(event: H3Event): Promise<string> {
  const body = await readBody<{ repository?: unknown }>(event)
  if (typeof body?.repository !== 'string' || !repositoryPattern.test(body.repository))
    throw createError({ statusCode: 400, statusMessage: 'A valid repository is required.' })
  return body.repository
}

export async function setMockRepositoryPaused(event: H3Event, paused: boolean): Promise<{ github: string, paused: boolean }> {
  const github = await repositoryFrom(event)
  let found = false
  updateMock(current => ({
    ...current,
    repositories: current.repositories.map((repository) => {
      if (repository.github !== github)
        return repository
      found = true
      return { ...repository, paused }
    }),
  }))
  if (!found)
    throw createError({ statusCode: 404, statusMessage: 'That repository is not mapped.' })
  return { github, paused }
}

export async function setMockRepositoryWrites(event: H3Event, writesEnabled: boolean): Promise<{ github: string, writesEnabled: boolean }> {
  const github = await repositoryFrom(event)
  let found = false
  updateMock(current => ({
    ...current,
    repositories: current.repositories.map((repository) => {
      if (repository.github !== github || repository.ownership === 'external')
        return repository
      found = true
      return { ...repository, writesEnabled }
    }),
  }))
  if (!found)
    throw createError({ statusCode: 404, statusMessage: 'That repository is not mapped.' })
  return { github, writesEnabled }
}

export async function setMockItemDismissed(event: H3Event, dismissed: boolean): Promise<{ _tag: 'Dismissed' | 'Restored' }> {
  const body = await readBody<{ repository?: unknown, itemNumber?: unknown }>(event)
  if (typeof body?.repository !== 'string' || !repositoryPattern.test(body.repository)
    || typeof body.itemNumber !== 'number' || !Number.isSafeInteger(body.itemNumber) || body.itemNumber < 1) {
    throw createError({ statusCode: 400, statusMessage: 'A valid repository and item number are required.' })
  }
  const { repository, itemNumber } = body
  /* Validate first, as the controller does, so a refused Dismiss leaves the board untouched. */
  const tracked = currentMockSnapshot().items.some(item => item.repository === repository && item.number === itemNumber)
  if (!tracked)
    throw createError({ statusCode: 404, statusMessage: 'This issue or pull request is no longer tracked.' })
  updateMock(current => ({
    ...current,
    items: current.items.map(item => item.repository === repository && item.number === itemNumber ? { ...item, dismissed } : item),
    /* A Dismissal leaves the Queue and cancels its Tasks; Restore waits for the next observation. */
    queue: dismissed ? current.queue.filter(entry => entry.repository !== repository || entry.number !== itemNumber) : current.queue,
  }))
  return { _tag: dismissed ? 'Dismissed' : 'Restored' }
}
