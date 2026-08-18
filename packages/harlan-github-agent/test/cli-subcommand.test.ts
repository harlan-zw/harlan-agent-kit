import { describe, expect, it } from 'vitest'
import { invokesSubCommand } from '../src/cli-subcommand.ts'

describe('invokesSubCommand', () => {
  it('reports the sweep subcommand, so the service does not also start', () => {
    // citty runs the parent command after a subcommand, so the parent must know
    // it has nothing to do. Otherwise a sweep binds the dashboard port too.
    expect(invokesSubCommand(['sweep-worktrees', '--dry-run'], ['sweep-worktrees'])).toBe(true)
  })

  it('reports no subcommand when the service starts normally', () => {
    expect(invokesSubCommand(['--config', '/etc/agent.yml'], ['sweep-worktrees'])).toBe(false)
  })

  it('reports no subcommand for an empty invocation', () => {
    expect(invokesSubCommand([], ['sweep-worktrees'])).toBe(false)
  })

  it('ignores a subcommand name that arrives as an option value', () => {
    expect(invokesSubCommand(['--config', 'sweep-worktrees'], ['sweep-worktrees'])).toBe(false)
  })
})
