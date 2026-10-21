import { describe, expect, it } from 'vitest'
import { authorizeGitHubCommand, parseGitHubCommand } from '../src/github-commands.ts'

describe('explicit GitHub commands', () => {
  it.each(['> @octorun review', '```\n@octorun review\n```', '@other review', 'Please @octorun repair this', '    @octorun review'])('ignores quoted, fenced, and incidental mentions: %s', (body) => {
    expect(parseGitHubCommand(body, 'octorun')).toEqual({ _tag: 'Ignored' })
  })

  it('keeps information and review commands distinct', () => {
    expect(parseGitHubCommand('@octorun status', 'octorun')).toEqual({ _tag: 'Command', command: { _tag: 'Status' } })
    expect(parseGitHubCommand('@octorun review full', 'octorun')).toEqual({ _tag: 'Command', command: { _tag: 'Review', full: true } })
    expect(parseGitHubCommand('@octorun run release-summary', 'octorun')).toEqual({ _tag: 'Command', command: { _tag: 'Run', workflow: 'release-summary' } })
    expect(parseGitHubCommand('@octorun fix everything', 'octorun')).toEqual({ _tag: 'Unknown', text: 'fix everything' })
  })

  it('keeps shorter fences and HTML comments inert', () => {
    expect(parseGitHubCommand('````markdown\n```\n@octorun review\n````', 'octorun')).toEqual({ _tag: 'Ignored' })
    expect(parseGitHubCommand('<!-- hidden example\n@octorun review\n-->', 'octorun')).toEqual({ _tag: 'Ignored' })
  })

  it('authorizes an organization collaborator by repository permission and stable identity', async () => {
    const calls: string[] = []
    const result = await authorizeGitHubCommand({ command: { _tag: 'Pause' }, actor: { id: 14, login: 'alice', kind: 'User' }, repository: 'acme/project', resolvePermission: async (repository, actor) => {
      calls.push(`${repository}:${actor.id}`)
      return { _tag: 'Ok', value: 'write' }
    } })
    expect(result).toEqual({ _tag: 'Ok', value: undefined })
    expect(calls).toEqual(['acme/project:14'])
  })

  it('does not let read access spend model capacity or enable repair', async () => {
    const base = { actor: { id: 14, login: 'alice', kind: 'User' as const }, repository: 'acme/project', resolvePermission: async () => ({ _tag: 'Ok' as const, value: 'read' as const }) }
    expect(await authorizeGitHubCommand({ ...base, command: { _tag: 'Status' } })).toEqual({ _tag: 'Ok', value: undefined })
    expect(await authorizeGitHubCommand({ ...base, command: { _tag: 'Review', full: false } })).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization' } })
    expect(await authorizeGitHubCommand({ ...base, command: { _tag: 'Repair', finding: 'f-1' }, allowOutsideSpending: true })).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization' } })
  })
})
