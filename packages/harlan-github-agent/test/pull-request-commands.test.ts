import type { PullRequestCommand } from '../src/repository-policy.ts'
import type { GitHubPullRequestItem, RepositoryMapping } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { acceptedPullRequestCommands } from '../src/repository-policy.ts'
import { ok } from '../src/result.ts'
import { automatedDisclosure } from '../src/review-comment.ts'
import { syncOpenReviewRerunRequests } from '../src/review-rerun-controller.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
afterEach(() => stores.splice(0).forEach(store => store.close()))

const allowed = ['harlan-zw']

interface CommandCase {
  name: string
  mapping: RepositoryMapping
  pullRequest: GitHubPullRequestItem
  allowedAuthors: string[]
  commands: PullRequestCommand[]
}

const cases: CommandCase[] = [
  {
    name: 'an owned repository and a writable head branch',
    mapping: repositoryMapping(),
    pullRequest: pullRequestItem({ mergeState: 'clean' }),
    allowedAuthors: allowed,
    commands: ['Change', 'Rerun'],
  },
  {
    name: 'a maintained repository',
    mapping: repositoryMapping({ ownership: 'maintained' }),
    pullRequest: pullRequestItem({ mergeState: 'clean' }),
    allowedAuthors: allowed,
    commands: ['Rerun'],
  },
  {
    name: 'an external repository',
    mapping: repositoryMapping({ ownership: 'external' }),
    pullRequest: pullRequestItem({ mergeState: 'clean' }),
    allowedAuthors: allowed,
    commands: ['Rerun'],
  },
  {
    name: 'a fork head the owner cannot modify',
    mapping: repositoryMapping(),
    pullRequest: pullRequestItem({ mergeState: 'clean', headRepository: 'contributor/example', maintainerCanModify: false }),
    allowedAuthors: allowed,
    commands: ['Rerun'],
  },
  {
    name: 'a head branch outside the writable prefixes',
    mapping: repositoryMapping(),
    pullRequest: pullRequestItem({ mergeState: 'clean', headRef: 'experiment/broken-thing' }),
    allowedAuthors: allowed,
    commands: ['Rerun'],
  },
  {
    name: 'an owned repository whose owner cannot command it',
    mapping: repositoryMapping({ github: 'acme/example' }),
    pullRequest: pullRequestItem({ mergeState: 'clean', repository: 'acme/example', headRepository: 'acme/example', url: 'https://github.com/acme/example/pull/24' }),
    allowedAuthors: allowed,
    commands: ['Rerun'],
  },
  {
    name: 'no allowed author who may write the repository',
    mapping: repositoryMapping(),
    pullRequest: pullRequestItem({ mergeState: 'clean' }),
    allowedAuthors: ['someone-else'],
    commands: [],
  },
  {
    name: 'a draft pull request',
    mapping: repositoryMapping(),
    pullRequest: pullRequestItem({ mergeState: 'clean', draft: true }),
    allowedAuthors: allowed,
    commands: [],
  },
  {
    name: 'a closed pull request',
    mapping: repositoryMapping(),
    pullRequest: pullRequestItem({ mergeState: 'clean', state: 'closed' }),
    allowedAuthors: allowed,
    commands: [],
  },
  {
    name: 'a repository without pull request Review',
    mapping: repositoryMapping({ pullRequestReview: false }),
    pullRequest: pullRequestItem({ mergeState: 'clean' }),
    allowedAuthors: allowed,
    commands: [],
  },
  {
    name: 'a disabled repository',
    mapping: repositoryMapping({ enabled: false }),
    pullRequest: pullRequestItem({ mergeState: 'clean' }),
    allowedAuthors: allowed,
    commands: [],
  },
]

/** Sends one command from every allowed author through the real command sync and store. */
async function storeAccepts(input: CommandCase, command: PullRequestCommand): Promise<boolean> {
  const store = openJournalStore(':memory:')
  stores.push(store)
  const at = '2026-10-09T01:00:00.000Z'
  // The store observes only enabled repositories, so a disabled one is disabled after its pull request arrived.
  store.syncRepositories([{ ...input.mapping, enabled: true }], at)
  store.recordObservation({ externalId: 'pr', observedAt: at, source: 'poll', subject: input.pullRequest })
  store.syncRepositories([input.mapping], at)
  const requests = input.allowedAuthors.map((author, index) => command === 'Change'
    ? { author, commentId: index + 1, origin: 'ChangeRequest' as const, instruction: 'Rename the option.', pullRequestNumber: input.pullRequest.number, updatedAt: at }
    : { author, commentId: index + 1, origin: 'Command' as const, pullRequestNumber: input.pullRequest.number, updatedAt: at })
  const synced = await syncOpenReviewRerunRequests([input.mapping], {
    github: { listReviewRerunRequests: async () => ok(requests) },
    store,
    allowedAuthors: input.allowedAuthors,
    now: () => new Date(at),
  })
  return synced.some(result => result._tag === 'Ok' && result.value.results.some(item => item._tag !== 'Rejected'))
}

describe('pull request comment commands', () => {
  it.each(cases)('accepts the expected commands on $name', (input) => {
    expect(acceptedPullRequestCommands(input.mapping, input.pullRequest, input.allowedAuthors)).toEqual(input.commands)
  })

  it.each(cases)('matches what the store accepts on $name', async (input) => {
    const accepted = acceptedPullRequestCommands(input.mapping, input.pullRequest, input.allowedAuthors)
    expect(await storeAccepts(input, 'Change')).toBe(accepted.includes('Change'))
    expect(await storeAccepts(input, 'Rerun')).toBe(accepted.includes('Rerun'))
  })

  it('names both commands when the pull request accepts both', () => {
    expect(automatedDisclosure({ kind: 'review', commands: ['Change', 'Rerun'] }))
      .toMatch(/ · `@harlan-agent rerun` · `@harlan-agent <change>`<\/sub>$/)
  })

  it('names only rerun when the pull request accepts only rerun', () => {
    const footer = automatedDisclosure({ kind: 'review', commands: ['Rerun'] })
    expect(footer).toMatch(/ · `@harlan-agent rerun`<\/sub>$/)
    expect(footer).not.toContain('<change>')
  })

  it('names no command when the pull request accepts none', () => {
    expect(automatedDisclosure({ kind: 'review', commands: [] })).not.toContain('@harlan-agent')
  })
})
