import type { ThreadEvent } from '@openai/codex-sdk'
import { describe, expect, it } from 'vitest'
import { agentActivityFromEvent, createAgentActivityLog, redactSecrets, truncateOutput } from '../src/agent-activity.ts'

function commandEvent(type: 'item.started' | 'item.completed', command: string, output: string, exitCode?: number): ThreadEvent {
  return {
    type,
    item: {
      id: 'item-1',
      type: 'command_execution',
      command,
      aggregated_output: output,
      status: type === 'item.started' ? 'in_progress' : 'completed',
      ...(exitCode === undefined ? {} : { exit_code: exitCode }),
    },
  } as ThreadEvent
}

describe('redactSecrets', () => {
  it('masks the token in an authenticated git remote', () => {
    expect(redactSecrets('git push https://x-access-token:ghs_abc123@github.com/o/r'))
      .toBe('git push https://x-access-token:***@github.com/o/r')
  })

  it('masks github and openai tokens found in output', () => {
    expect(redactSecrets('token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX key=sk-ABCDEFGHIJKLMNOPQRSTUV'))
      .toBe('token=ghp_*** key=sk-***')
  })

  it('keeps commit shas intact', () => {
    const sha = '9d41c7be3a52f0aa11bb22cc33dd44ee55ff6600'
    expect(redactSecrets(`checkout ${sha}`)).toBe(`checkout ${sha}`)
  })
})

describe('truncateOutput', () => {
  it('keeps the tail, which is where the failure is', () => {
    const output = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n')
    const truncated = truncateOutput(output)
    expect(truncated).toContain('line 39')
    expect(truncated).not.toContain('line 0\n')
  })
})

describe('agentActivityFromEvent', () => {
  it('records a finished command with its redacted output and exit code', () => {
    const item = agentActivityFromEvent(commandEvent('item.completed', 'pnpm test', 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX\nfailed', 1), '2026-08-14T00:00:00.000Z')
    expect(item).toEqual({
      _tag: 'Command',
      at: '2026-08-14T00:00:00.000Z',
      command: 'pnpm test',
      output: 'token=ghp_***\nfailed',
      exitCode: 1,
    })
  })

  it('ignores events that say nothing about what the agent is doing', () => {
    expect(agentActivityFromEvent({ type: 'thread.started', thread_id: 'thread-1' } as ThreadEvent, '2026-08-14T00:00:00.000Z')).toBeUndefined()
  })
})

describe('createAgentActivityLog', () => {
  it('replaces a started command with its completed line rather than duplicating it', () => {
    const log = createAgentActivityLog()
    log.record('task-1', agentActivityFromEvent(commandEvent('item.started', 'pnpm test', ''), '2026-08-14T00:00:00.000Z')!)
    log.record('task-1', agentActivityFromEvent(commandEvent('item.completed', 'pnpm test', 'ok', 0), '2026-08-14T00:00:01.000Z')!)
    expect(log.read('task-1')).toEqual([
      { _tag: 'Command', at: '2026-08-14T00:00:01.000Z', command: 'pnpm test', output: 'ok', exitCode: 0 },
    ])
  })

  it('keeps only the most recent items for one agent', () => {
    const log = createAgentActivityLog({ itemLimit: 2 })
    for (const index of [1, 2, 3]) {
      log.record('task-1', { _tag: 'Reasoning', at: `2026-08-14T00:00:0${index}.000Z`, text: `step ${index}` })
    }
    expect(log.read('task-1').map(item => item._tag === 'Reasoning' ? item.text : '')).toEqual(['step 2', 'step 3'])
  })

  it('drops the oldest agent once the agent limit is passed', () => {
    const log = createAgentActivityLog({ agentLimit: 1 })
    log.record('task-1', { _tag: 'Reasoning', at: '2026-08-14T00:00:01.000Z', text: 'first' })
    log.record('task-2', { _tag: 'Reasoning', at: '2026-08-14T00:00:02.000Z', text: 'second' })
    expect(log.read('task-1')).toEqual([])
    expect(log.read('task-2')).toHaveLength(1)
  })

  it('returns nothing for an agent that has been cleared', () => {
    const log = createAgentActivityLog()
    log.record('task-1', { _tag: 'Reasoning', at: '2026-08-14T00:00:01.000Z', text: 'first' })
    log.clear('task-1')
    expect(log.read('task-1')).toEqual([])
  })
})
