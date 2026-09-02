import { describe, expect, it } from 'vitest'
import { forwardLeadingOptions } from '../src/cli-leading-options.ts'

const valueOptions = ['--config', '-c', '--url', '--password-file']

describe('forwardLeadingOptions', () => {
  it('moves a leading --config with its value behind the control subcommand', () => {
    expect(forwardLeadingOptions(['--config', 'a.yml', 'control', 'status'], valueOptions, 'control'))
      .toEqual(['control', 'status', '--config', 'a.yml'])
  })

  it('moves every leading connection option, including attached values and aliases', () => {
    expect(forwardLeadingOptions(['-c', 'a.yml', '--url=http://x', 'control', 'tasks'], valueOptions, 'control'))
      .toEqual(['control', 'tasks', '-c', 'a.yml', '--url=http://x'])
  })

  it('leaves arguments alone when the subcommand is already first', () => {
    expect(forwardLeadingOptions(['control', 'status', '--config', 'a.yml'], valueOptions, 'control'))
      .toEqual(['control', 'status', '--config', 'a.yml'])
  })

  it('leaves arguments alone when the first positional is another subcommand', () => {
    expect(forwardLeadingOptions(['--config', 'a.yml', 'sweep-worktrees'], valueOptions, 'control'))
      .toEqual(['--config', 'a.yml', 'sweep-worktrees'])
  })

  it('leaves arguments alone when no subcommand follows the options', () => {
    expect(forwardLeadingOptions(['--config', 'a.yml'], valueOptions, 'control'))
      .toEqual(['--config', 'a.yml'])
  })

  it('forwards an unknown leading option without swallowing the subcommand', () => {
    expect(forwardLeadingOptions(['--nope', 'control', 'status'], valueOptions, 'control'))
      .toEqual(['control', 'status', '--nope'])
  })

  it('stops at the end-of-options marker', () => {
    expect(forwardLeadingOptions(['--', '--config', 'control'], valueOptions, 'control'))
      .toEqual(['--', '--config', 'control'])
  })
})
