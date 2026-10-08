import { describe, expect, it } from 'vitest'
import { ejectRecoveryFromError, ejectSessionCommand } from '../dashboard/app/utils/eject.ts'

describe('delayed Eject recovery', () => {
  it('keeps the saved session and next action from a tagged 503 response', () => {
    const result = ejectRecoveryFromError({
      data: {
        statusCode: 503,
        data: {
          _tag: 'EjectDelayed',
          provider: 'opencode',
          sessionId: 'ses_abc12345',
          nextAction: 'Stop Harlan GitHub Agent. Then resume this saved session.',
        },
      },
    }, 'hogwild')

    expect(result).toEqual({
      _tag: 'EjectDelayed',
      command: 'ssh -t \'hogwild\' \'\'\\\'\'/home/harlan/.local/bin/opencode\'\\\'\' \'\\\'\'--session\'\\\'\' \'\\\'\'ses_abc12345\'\\\'\'\'',
      sessionId: 'ses_abc12345',
      nextAction: 'Stop Harlan GitHub Agent. Then resume this saved session.',
    })
  })
})

it('resumes a desktop session on the desktop', () => {
  expect(ejectSessionCommand('codex', 'desktop:abc', 'hogwild')).toBe('# Run on Desktop\n\'/home/harlan/.local/bin/codex\' \'resume\' \'abc\' \'-c\' \'tui.resume_cwd="session"\'')
})

it.each(['ses_current123', 'desktop:ses_current123'])('routes isolated delayed Eject %s to the verified Task database', (sessionId) => {
  const key = 'a'.repeat(64)
  const failure = { statusCode: 503, data: { data: { _tag: 'EjectDelayed', provider: 'opencode', sessionId, opencodeTaskKey: key, nextAction: 'Stop Harlan GitHub Agent.' } } }
  const result = ejectRecoveryFromError(failure, 'hogwild')
  expect(result?.command).toBe(ejectSessionCommand('opencode', sessionId, 'hogwild', key))
  expect(result?.command).toContain('resume-session')
  expect(result?.command).toContain(key)
  expect(result?.command).not.toContain('desktop:ses_')
  expect(ejectRecoveryFromError({ ...failure, data: { data: { ...failure.data.data, opencodeTaskKey: '../wrong' } } }, 'hogwild')).toBeUndefined()
})
