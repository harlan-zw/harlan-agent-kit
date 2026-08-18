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

  it('rejects an entry that carries neither a branch nor a detached head', () => {
    const parsed = parseWtWorktrees(JSON.stringify([{ branch: 7, path: '/home/harlan/pkg/repo' }]))

    expect(parsed._tag).toBe('Err')
  })

  it('rejects a relative worktree path', () => {
    const parsed = parseWtWorktrees(JSON.stringify([entry('main', 'pkg/repo')]))

    expect(parsed._tag).toBe('Err')
  })
})
