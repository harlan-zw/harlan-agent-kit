import type { Actor, Result } from './types.ts'
import { err, ok } from './types.ts'

export type GitHubCommand
  = | { _tag: 'Help' | 'Status' | 'Configuration' | 'Pause' | 'Resume' | 'Cancel' }
    | { _tag: 'Review', full: boolean }
    | { _tag: 'Run', workflow: string }
    | { _tag: 'Repair', finding: string }

export type ParsedGitHubCommand
  = | { _tag: 'Ignored' }
    | { _tag: 'Unknown', text: string }
    | { _tag: 'Command', command: GitHubCommand }

/** Commands must occupy a line. Quoted prose and Markdown examples carry no authority. */
export function parseGitHubCommand(body: string, handle: string): ParsedGitHubCommand {
  const mention = `@${handle.replace(/^@/, '').toLowerCase()}`
  let fence: string | null = null
  let htmlComment = false
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    if (fence === null) {
      if (htmlComment) {
        if (line.includes('-->'))
          htmlComment = false
        continue
      }
      const opening = line.indexOf('<!--')
      if (opening !== -1) {
        htmlComment = !line.includes('-->', opening + 4)
        continue
      }
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker !== undefined) {
      if (fence === null)
        fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(line))
        fence = null
      continue
    }
    if (fence !== null || /^\s*>/.test(line) || /^(?: {4}|\t)/.test(line))
      continue
    const trimmed = line.trim()
    if (trimmed.slice(0, mention.length).toLowerCase() !== mention || !/^(?:\s|$)/.test(trimmed.slice(mention.length)))
      continue
    const text = trimmed.slice(mention.length).trim()
    const parts = text.toLowerCase().split(/\s+/)
    if (parts.length === 1) {
      const tags = { help: 'Help', status: 'Status', configuration: 'Configuration', pause: 'Pause', resume: 'Resume', cancel: 'Cancel' } as const
      const tag = tags[parts[0] as keyof typeof tags]
      if (tag !== undefined)
        return { _tag: 'Command', command: { _tag: tag } }
      if (parts[0] === 'review')
        return { _tag: 'Command', command: { _tag: 'Review', full: false } }
    }
    if (parts.length === 2 && parts[0] === 'review' && parts[1] === 'full')
      return { _tag: 'Command', command: { _tag: 'Review', full: true } }
    if (parts.length === 2 && /^(?:run|repair)$/.test(parts[0]!) && /^[a-z0-9][\w.-]{0,127}$/i.test(parts[1]!)) {
      const value = text.split(/\s+/)[1]!
      return { _tag: 'Command', command: parts[0] === 'run' ? { _tag: 'Run', workflow: value } : { _tag: 'Repair', finding: value } }
    }
    return { _tag: 'Unknown', text: text.slice(0, 500) }
  }
  return { _tag: 'Ignored' }
}

export type RepositoryPermission = 'none' | 'read' | 'triage' | 'write' | 'maintain' | 'admin'

export async function authorizeGitHubCommand(options: {
  command: GitHubCommand
  actor: Actor | null
  repository: string
  resolvePermission: (repository: string, actor: Actor) => Promise<Result<RepositoryPermission>>
  allowOutsideSpending?: boolean
  repairEnabled?: boolean
}): Promise<Result<void>> {
  if (options.actor === null || options.actor.kind !== 'User')
    return err({ _tag: 'Authorization', message: 'A GitHub user must request this command.' })
  const permission = await options.resolvePermission(options.repository, options.actor)
  if (permission._tag === 'Err')
    return permission
  const write = ['write', 'maintain', 'admin'].includes(permission.value)
  const read = permission.value !== 'none'
  const tag = options.command._tag
  if (['Help', 'Status', 'Configuration'].includes(tag))
    return read ? ok(undefined) : err({ _tag: 'Authorization', message: 'Repository read access is required.' })
  if (tag === 'Repair' && options.repairEnabled !== true)
    return err({ _tag: 'Authorization', message: 'The operator must enable a repair workflow.' })
  if (['Pause', 'Resume', 'Cancel', 'Repair'].includes(tag))
    return write ? ok(undefined) : err({ _tag: 'Authorization', message: 'Repository write access is required.' })
  return write || (read && options.allowOutsideSpending === true)
    ? ok(undefined)
    : err({ _tag: 'Authorization', message: 'Repository policy does not permit this user to start paid work.' })
}
