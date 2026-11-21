import { describe, expect, it } from 'vitest'
import { conflictStopReason } from '../src/conflict-stop.ts'
import { canPublishUncheckedConflictResolution, canResolveConflictPullRequestHead, conflictWriteBoundary } from '../src/repository-policy.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const fork = { author: 'contributor', headRepository: 'contributor/example' }

describe('conflict write boundary', () => {
  it.each([
    ['ConflictResolutionOff', { conflictResolution: false }, {}],
    ['RepositoryNotWritable', { ownership: 'external' as const }, {}],
    ['RepositoryNotWritable', { enabled: false }, {}],
    ['DefaultBranchHead', {}, { headRef: 'main' }],
    ['MaintainerEditsOff', {}, { ...fork, maintainerCanModify: false }],
    ['HeadPrefixNotWritable', {}, { headRef: 'feat-agent-connect-funnel-steps' }],
    ['AuthorNotWritable', {}, { author: 'contributor' }],
  ])('names %s as the first rule that stops the write', (_tag, mapping, pullRequest) => {
    expect(conflictWriteBoundary(repositoryMapping(mapping), pullRequestItem(pullRequest))).toMatchObject({ _tag })
    expect(canResolveConflictPullRequestHead(repositoryMapping(mapping), pullRequestItem(pullRequest))).toBe(false)
  })

  it('finds no boundary on a writable branch of an owned or maintained repository', () => {
    for (const ownership of ['owned', 'maintained'] as const) {
      expect(conflictWriteBoundary(repositoryMapping({ ownership }), pullRequestItem())).toBeNull()
      expect(canResolveConflictPullRequestHead(repositoryMapping({ ownership }), pullRequestItem())).toBe(true)
    }
    expect(conflictWriteBoundary(repositoryMapping(), pullRequestItem({ ...fork, maintainerCanModify: true }))).toBeNull()
  })

  it('publishes an unchecked merge only to a branch in the repository itself', () => {
    expect(canPublishUncheckedConflictResolution(repositoryMapping(), pullRequestItem())).toBe(true)
    expect(canPublishUncheckedConflictResolution(repositoryMapping({ ownership: 'maintained' }), pullRequestItem())).toBe(true)
    expect(canPublishUncheckedConflictResolution(repositoryMapping(), pullRequestItem({ ...fork, maintainerCanModify: true }))).toBe(false)
    expect(canPublishUncheckedConflictResolution(repositoryMapping(), pullRequestItem({ headRef: 'wip/x' }))).toBe(false)
  })
})

describe('conflict stop reason', () => {
  it.each([
    [{ conflictResolution: false }, {}, /conflict_resolution: true.*harlan-zw\/example/],
    [{ ownership: 'external' as const }, {}, /does not write to harlan-zw\/example/],
    [{}, { headRef: 'main' }, /head is the default branch main/],
    [{}, { ...fork, maintainerCanModify: false }, /Ask contributor to allow edits by maintainers on contributor\/example:fix\/broken-thing/],
    [{}, { headRef: 'feat-agent-connect-funnel-steps' }, /feat-agent-connect-funnel-steps does not start with fix\/, feat\/, or chore\/\. Merge main into it by hand/],
    [{}, { author: 'contributor' }, /contributor is not a writable pull request author for harlan-zw\/example\. Merge main into fix\/broken-thing by hand\./],
  ])('names the exact boundary and one step', (mapping, pullRequest, expected) => {
    const boundary = conflictWriteBoundary(repositoryMapping(mapping), pullRequestItem(pullRequest))
    if (boundary === null)
      throw new Error('Expected a boundary.')
    const reason = conflictStopReason({ _tag: 'Boundary', boundary }, repositoryMapping(mapping), pullRequestItem(pullRequest))
    expect(reason).toMatch(expected)
    expect(reason).not.toMatch(/permission/i)
  })

  it('names the protected branch and the unchecked fork merge', () => {
    expect(conflictStopReason({ _tag: 'ProtectedHead' }, repositoryMapping(), pullRequestItem()))
      .toBe('Branch fix/broken-thing is protected. Merge main into it by hand.')
    expect(conflictStopReason(
      { _tag: 'UncheckedFork', command: 'pnpm vitest run', error: 'Cannot find tsconfig.app.json' },
      repositoryMapping(),
      pullRequestItem({ ...fork, maintainerCanModify: true }),
    )).toBe('The agent resolved the merge conflict, but pnpm vitest run could not start: Cannot find tsconfig.app.json. '
      + 'The Service pushes a merge without local checks only to a branch in harlan-zw/example. Merge main into contributor/example:fix/broken-thing by hand.')
  })
})
