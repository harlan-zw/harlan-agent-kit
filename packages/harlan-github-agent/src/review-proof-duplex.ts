import type { Readable, Writable } from 'node:stream'
import type { ReviewProofAuthority } from './review-proof-authority.ts'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { parseReviewProofReserveResult } from './review-proof-controller.ts'

export interface ReviewProofCallback {
  _tag: 'ReviewProofCallback'
  id: string
  action: 'reserve' | 'finish'
  input: unknown
}
export function parseReviewProofCallback(input: unknown): ReviewProofCallback | null {
  if (typeof input !== 'object' || input === null || !('_tag' in input) || input._tag !== 'ReviewProofCallback')
    return null
  if (!('id' in input) || typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id)
    || !('action' in input) || (input.action !== 'reserve' && input.action !== 'finish')
    || !('input' in input) || Object.keys(input).length !== 4 || Buffer.byteLength(JSON.stringify(input)) > 80_000) {
    throw new Error('The Review proof callback is invalid.')
  }
  return { _tag: 'ReviewProofCallback', id: input.id, action: input.action, input: input.input }
}

/** Trusted desktop child callback channel. No controller credential enters the child. */
export function createReviewProofDuplex(input: Readable, output: Writable): { authority: ReviewProofAuthority, close: () => void } {
  const lines = createInterface({ input })
  let closed = false
  const pending = new Map<string, { resolve: (value: unknown) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> }>()
  const close = () => {
    lines.close()
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('The controller proof callback disconnected.'))
    }
    pending.clear()
  }
  lines.on('close', () => {
    closed = true
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('The controller proof callback disconnected.'))
    }
    pending.clear()
  })
  lines.on('line', (line) => {
    if (Buffer.byteLength(line) > 80_000) {
      close()
      return
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    }
    catch {
      // Invalid callback bytes revoke the channel and reject every waiting invocation.
      close()
      return
    }
    if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string') {
      close()
      return
    }
    const entry = pending.get(value.id)
    if (entry === undefined)
      return
    clearTimeout(entry.timer)
    pending.delete(value.id)
    if ('error' in value && typeof value.error === 'string')
      entry.reject(new Error(value.error.slice(0, 500)))
    else if ('result' in value)
      entry.resolve(value.result)
    else
      entry.reject(new Error('The controller proof callback response is invalid.'))
  })
  const request = (action: ReviewProofCallback['action'], value: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (closed) {
      reject(new Error('The controller proof callback disconnected.'))
      return
    }
    const id = randomUUID()
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('The controller proof callback timed out.'))
    }, 45_000)
    pending.set(id, { resolve, reject, timer })
    output.write(`${JSON.stringify({ _tag: 'ReviewProofCallback', id, action, input: value })}\n`)
  })
  return {
    close,
    authority: {
      reserve: async value => parseReviewProofReserveResult(await request('reserve', value)),
      finish: async (value) => {
        const result = await request('finish', value)
        if (typeof result !== 'object' || result === null || !('_tag' in result) || result._tag !== 'Recorded' || Object.keys(result).length !== 1)
          throw new Error('The Review proof receipt response is invalid.')
      },
    },
  }
}
