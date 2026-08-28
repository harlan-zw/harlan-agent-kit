import { describe, expect, it } from 'vitest'
import { ejectRecoveryFromError } from '../dashboard/app/utils/eject.ts'

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
