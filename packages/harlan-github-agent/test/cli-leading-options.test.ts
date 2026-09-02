import { describe, expect, it } from 'vitest'
import { forwardLeadingOptions } from '../src/cli-leading-options.ts'

const valueOptions = ['--config', '-c', '--url', '--password-file']
const subCommands = ['combine-service-state', 'sweep-worktrees', 'control']

describe('forwardLeadingOptions', () => {
  it('moves a leading --config with its value behind the control subcommand', () => {
    expect(forwardLeadingOptions(['--config', 'a.yml', 'control', 'status'], valueOptions, subCommands))
      .toEqual(['control', 'status', '--config', 'a.yml'])
  })

  it('moves every leading connection option, including attached values and aliases', () => {
    expect(forwardLeadingOptions(['-c', 'a.yml', '--url=http://x', 'control', 'tasks'], valueOptions, subCommands))
      .toEqual(['control', 'tasks', '-c', 'a.yml', '--url=http://x'])
  })

  it('leaves arguments alone when the subcommand is already first', () => {
    expect(forwardLeadingOptions(['control', 'status', '--config', 'a.yml'], valueOptions, subCommands))
      .toEqual(['control', 'status', '--config', 'a.yml'])
  })

  it('moves a leading --config behind sweep-worktrees', () => {
    expect(forwardLeadingOptions(['--config', 'a.yml', 'sweep-worktrees', '--dry-run'], valueOptions, subCommands))
      .toEqual(['sweep-worktrees', '--dry-run', '--config', 'a.yml'])
  })

  it('moves a leading --config behind combine-service-state', () => {
    expect(forwardLeadingOptions(['-c', 'a.yml', 'combine-service-state', 'g.json', 'r.json'], valueOptions, subCommands))
      .toEqual(['combine-service-state', 'g.json', 'r.json', '-c', 'a.yml'])
  })

  it('leaves arguments alone when the first positional is not a known subcommand', () => {
    expect(forwardLeadingOptions(['--config', 'a.yml', 'unknown'], valueOptions, subCommands))
      .toEqual(['--config', 'a.yml', 'unknown'])
  })

  it('leaves arguments alone when no subcommand follows the options', () => {
    expect(forwardLeadingOptions(['--config', 'a.yml'], valueOptions, subCommands))
      .toEqual(['--config', 'a.yml'])
  })

  it('forwards an unknown leading option without swallowing the subcommand', () => {
    expect(forwardLeadingOptions(['--nope', 'control', 'status'], valueOptions, subCommands))
      .toEqual(['control', 'status', '--nope'])
  })

  it('stops at the end-of-options marker', () => {
    expect(forwardLeadingOptions(['--', '--config', 'control'], valueOptions, subCommands))
      .toEqual(['--', '--config', 'control'])
  })
})
