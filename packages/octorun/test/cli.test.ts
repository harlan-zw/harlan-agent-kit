import { expect, it } from 'vitest'
import { parseCliArguments } from '../src/cli-arguments.ts'

it('requires explicit repository and pull request for manual execution', () => {
  const result = parseCliArguments(['run', '--repository', 'team/example', '--pr', '7', '--workflow', 'review', '--request-id', 'manual-7', '--json'])
  expect(result).toEqual({ _tag: 'Ok', value: { _tag: 'Run', repository: 'team/example', number: 7, workflow: 'review', requestId: 'manual-7', json: true } })
  expect(parseCliArguments(['run', '--repository', 'team/example'])._tag).toBe('Err')
})

it.each([
  ['run', '--repository', 'team/example', '--pr', '7oops'],
  ['serve', '--unknown'],
  ['poll', '--backfill', 'everything'],
  ['cancel'],
  ['init', '--repository', 'team/example'],
  ['restore'],
  ['status', '--config'],
])('rejects incomplete or ambiguous commands: %s', (...args) => {
  expect(parseCliArguments(args)._tag).toBe('Err')
})

it('defaults polling to current observations without initial backfill', () => {
  expect(parseCliArguments(['poll'])).toEqual({ _tag: 'Ok', value: { _tag: 'Poll', backfill: false, json: false } })
  expect(parseCliArguments(['poll', '--backfill', 'existing'])).toEqual({ _tag: 'Ok', value: { _tag: 'Poll', backfill: true, json: false } })
})

it('accepts global options before the command', () => {
  expect(parseCliArguments(['--config', '/cfg/octorun.yaml', '--json', 'validate']))
    .toEqual({ _tag: 'Ok', value: { _tag: 'Validate', configPath: '/cfg/octorun.yaml', json: true } })
})

it('offers config validation and familiar help aliases', () => {
  expect(parseCliArguments(['config', 'validate'])).toEqual({ _tag: 'Ok', value: { _tag: 'Validate', json: false } })
  expect(parseCliArguments(['config'])).toEqual({ _tag: 'Ok', value: { _tag: 'Configuration', json: false } })
  expect(parseCliArguments(['-h'])).toEqual({ _tag: 'Ok', value: { _tag: 'Help', json: false } })
})

it('distinguishes controller admission controls from repository controls', () => {
  expect(parseCliArguments(['pause'])).toEqual({ _tag: 'Ok', value: { _tag: 'Pause', scope: { _tag: 'Controller' }, json: false } })
  expect(parseCliArguments(['resume'])).toEqual({ _tag: 'Ok', value: { _tag: 'Resume', scope: { _tag: 'Controller' }, json: false } })
  expect(parseCliArguments(['resume', '--repository', 'example/project', '--pr', '7'])).toEqual({ _tag: 'Ok', value: { _tag: 'Resume', scope: { _tag: 'Repository', repository: 'example/project', targetKey: null, number: 7 }, json: false } })
  expect(parseCliArguments(['pause', '--pr', '7'])._tag).toBe('Err')
  expect(parseCliArguments(['resume', '--target', '1:pull_request:7'])._tag).toBe('Err')
})
