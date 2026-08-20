import { describe, expect, it } from 'vitest'
import { parseWtWorktrees } from '../src/worktree.ts'

function entry(branch: string | null, path: string): unknown {
  return { branch, path, kind: 'worktree', detached: branch === null ? null : false }
}

describe('parseWtWorktrees', () => {
  it('keeps every branch worktree when a detached worktree sits between them', () => {
    const parsed = parseWtWorktrees(JSON.stringify([
      entry('main', '/home/harlan/pkg/repo'),
      entry(null, '/tmp/opencode/repo-main'),
      entry('harlan-agent/review-1', '/home/harlan/pkg/repo.review-1'),
    ]))

    expect(parsed).toEqual({
      _tag: 'Ok',
      value: [
        { branch: 'main', path: '/home/harlan/pkg/repo' },
        { branch: 'harlan-agent/review-1', path: '/home/harlan/pkg/repo.review-1' },
      ],
    })
  })

  it('keeps the claimable worktrees around an entry it cannot use', () => {
    const parsed = parseWtWorktrees(JSON.stringify([
      { branch: 7, path: '/home/harlan/pkg/repo' },
      { path: '/home/harlan/pkg/repo.pruned' },
      entry('main', 'pkg/repo.relative'),
      { kind: 'session', name: 'something wt grew later' },
      entry('harlan-agent/conflict-1', '/home/harlan/pkg/repo.conflict-1'),
    ]))

    expect(parsed).toEqual({
      _tag: 'Ok',
      value: [{ branch: 'harlan-agent/conflict-1', path: '/home/harlan/pkg/repo.conflict-1' }],
    })
  })

  it('rejects output that is not a list of worktrees', () => {
    expect(parseWtWorktrees('{"worktrees":[]}')._tag).toBe('Err')
    expect(parseWtWorktrees('not json')._tag).toBe('Err')
  })
})
