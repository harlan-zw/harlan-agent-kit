import type { JevClient, Questions, SystemOneResult } from 'advocaat'
import type { Result } from './result.ts'
import { err, ok } from './result.ts'

/** Why a classification call failed. `Aborted` is an ordinary cancellation, never an Incident. */
export type ClassificationFailure
  = | { _tag: 'Unavailable', message: string }
    | { _tag: 'Aborted' }

/**
 * The boundary to every Jev classification. Failures are values, so a caller
 * cannot forget the safe direction. The client is injected, never imported
 * behind the interface.
 */
export interface ClassificationSource {
  classify: <Q extends Questions>(input: {
    state: Parameters<JevClient['systemOne']>[0]['state']
    questions: Q
    signal?: AbortSignal
  }) => Promise<Result<SystemOneResult<Q>, ClassificationFailure>>
}

export interface ClassificationSourceOptions {
  client: JevClient
}

export function createClassificationSource(options: ClassificationSourceOptions): ClassificationSource {
  return {
    async classify(input) {
      try {
        const result = await options.client.systemOne(
          { state: input.state, questions: input.questions },
          input.signal === undefined ? {} : { signal: input.signal },
        )
        return ok(result)
      }
      catch (error: unknown) {
        if (error instanceof DOMException && error.name === 'AbortError')
          return err({ _tag: 'Aborted' })
        return err({
          _tag: 'Unavailable',
          message: error instanceof Error ? error.message : 'The classification service failed.',
        })
      }
    },
  }
}
