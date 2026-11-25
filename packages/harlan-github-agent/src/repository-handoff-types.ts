import type { Result } from './result.ts'
import { err, ok } from './result.ts'

export interface HandoffItem { _tag: 'Issue' | 'PullRequest', number: number }
export type HandoffSender = { _tag: 'Control', agent: string } | { _tag: 'Task', taskId: string, kind: string }

export interface HandoffDraft {
  message: string
  item?: HandoffItem
  replyTo?: number
}

export interface PostHandoff extends HandoffDraft {
  repository: string
  agent: string
  requestId: string
}

export interface RepositoryHandoff {
  id: number
  repository: string
  sender: HandoffSender
  message: string
  item: HandoffItem | null
  replyTo: number | null
  createdAt: string
}

export interface HandoffQuery {
  repository: string
  after?: number
  limit?: number
  waitSeconds?: number
}

export interface HandoffPage {
  handoffs: RepositoryHandoff[]
  cursor: number
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const repositoryName = /^[\w.-]+\/[\w.-]+$/
const agentName = /^[\w.-]{1,80}$/
const requestKey = /^[\w.:-]{1,128}$/

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
}

function itemReference(value: unknown): value is HandoffItem {
  return isRecord(value) && (value._tag === 'Issue' || value._tag === 'PullRequest') && integer(value.number, 1)
}

export function parseHandoffDraft(value: unknown): Result<HandoffDraft, string> {
  if (!isRecord(value) || typeof value.message !== 'string' || value.message.trim() === '' || Buffer.byteLength(value.message) > 1600)
    return err('Set a Handoff message from 1 to 1600 bytes.')
  if (value.replyTo != null && !integer(value.replyTo, 1))
    return err('Set reply-to to a Handoff ID.')
  if (value.item !== undefined && (!itemReference(value.item) || value.replyTo != null))
    return err('Link a Handoff to one Issue, pull request, or earlier Handoff.')
  return ok({
    message: value.message.trim(),
    ...(value.item === undefined ? {} : { item: { _tag: value.item._tag, number: value.item.number } }),
    ...(value.replyTo == null ? {} : { replyTo: value.replyTo }),
  })
}

export function parsePostHandoff(value: unknown): Result<PostHandoff, string> {
  if (!isRecord(value) || typeof value.repository !== 'string' || !repositoryName.test(value.repository))
    return err('Set repository as OWNER/NAME.')
  if (typeof value.agent !== 'string' || !agentName.test(value.agent))
    return err('Set agent to a session name using letters, numbers, dots, hyphens, or underscores.')
  if (typeof value.requestId !== 'string' || !requestKey.test(value.requestId))
    return err('Set a valid Handoff request ID.')
  const draft = parseHandoffDraft(value)
  if (draft._tag === 'Err')
    return draft
  return ok({ ...draft.value, repository: value.repository.toLowerCase(), agent: value.agent, requestId: value.requestId })
}

export function parseHandoffQuery(search: URLSearchParams): Result<HandoffQuery, string> {
  const repository = search.get('repository')
  if (repository === null || !repositoryName.test(repository))
    return err('Set repository as OWNER/NAME.')
  const readInteger = (name: string) => {
    const value = search.get(name)
    return value === null ? undefined : /^\d+$/.test(value) ? Number(value) : NaN
  }
  const after = readInteger('after')
  const limit = readInteger('limit')
  const waitSeconds = readInteger('wait-seconds')
  if (after !== undefined && !integer(after))
    return err('Set after to a Handoff cursor.')
  if (limit !== undefined && !integer(limit, 1, 50))
    return err('Set limit from 1 to 50.')
  if (waitSeconds !== undefined && (!integer(waitSeconds, 1, 25) || after === undefined))
    return err('To wait, set after and set wait-seconds from 1 to 25.')
  return ok({
    repository: repository.toLowerCase(),
    ...(after === undefined ? {} : { after }),
    ...(limit === undefined ? {} : { limit }),
    ...(waitSeconds === undefined ? {} : { waitSeconds }),
  })
}

function isHandoff(value: unknown): value is RepositoryHandoff {
  if (!isRecord(value) || !integer(value.id, 1) || typeof value.repository !== 'string'
    || !repositoryName.test(value.repository) || typeof value.message !== 'string' || typeof value.createdAt !== 'string'
    || (value.item !== null && !itemReference(value.item)) || (value.replyTo !== null && !integer(value.replyTo, 1))
    || !isRecord(value.sender)) {
    return false
  }
  const sender = value.sender
  return (sender._tag === 'Control' && typeof sender.agent === 'string' && agentName.test(sender.agent))
    || (sender._tag === 'Task' && typeof sender.taskId === 'string' && typeof sender.kind === 'string')
}

export function parseHandoffReceipt(value: unknown): Result<RepositoryHandoff, string> {
  return isHandoff(value) ? ok(value) : err('The Service returned an invalid Handoff.')
}

export function parseHandoffPage(value: unknown): Result<HandoffPage, string> {
  return isRecord(value) && integer(value.cursor) && Array.isArray(value.handoffs) && value.handoffs.every(isHandoff)
    ? ok({ handoffs: value.handoffs, cursor: value.cursor })
    : err('The Service returned an invalid Handoff page.')
}
