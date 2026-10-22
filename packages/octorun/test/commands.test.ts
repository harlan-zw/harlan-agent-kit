import { describe, expect, it } from 'vitest'
import { kitExitCode, kitOperation, parseKitCommand } from '../src/commands.ts'

describe('kit commands', () => {
  it.each([
    ['run', '--pr', '7'],
    ['--config', '/private/config.yml', 'run', '--pr', '7'],
    ['--config=/private/config.yml', 'run', '--pr', '7'],
  ])('selects the Kit change summary for %j', (...args) => {
    const result = parseKitCommand(args)
    expect(result).toMatchObject({ _tag: 'Ok', value: { _tag: 'Run', number: 7, repository: 'harlan-zw/harlan-agent-kit', workflow: 'change-summary' } })
    if (result._tag === 'Ok')
      expect(kitOperation(result.value)).toMatchObject({ _tag: 'Ok', value: { command: 'run', args: { workflow: 'change-summary' } } })
  })

  it('keeps an explicit adversarial review selection', () => {
    const result = parseKitCommand(['run', '--pr', '7', '--workflow', 'adversarial-review'])
    expect(result).toMatchObject({ _tag: 'Ok', value: { workflow: 'adversarial-review' } })
  })

  it('rejects another repository before any effect', () => {
    expect(parseKitCommand(['run', '--pr', '7', '--repository', 'other/project'])).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization' } })
  })

  it('preserves request identity and target scope', () => {
    const result = parseKitCommand(['run', '--pr', '7', '--request-id', 'operator-123'])
    if (result._tag === 'Err')
      throw new Error(result.error.message)
    expect(kitOperation(result.value)).toMatchObject({ _tag: 'Ok', value: { args: { number: 7, requestId: 'operator-123', repository: 'harlan-zw/harlan-agent-kit' } } })
  })

  it.each(['Failed', 'Cancelled', 'Superseded'])('returns failure for a %s run', (state) => {
    expect(kitExitCode({ _tag: 'Ok', value: { state } })).toBe(1)
  })

  it('returns failure for an unready diagnostic', () => {
    expect(kitExitCode({ _tag: 'Ok', value: { ready: false } })).toBe(1)
  })
})
