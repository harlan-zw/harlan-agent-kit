import { defineEventHandler } from 'h3'
import { assertDevMock } from '../../utils/mock.ts'

/**
 * Dev only. The dev mock has no sign-in, so the gate would stop at Retry.
 * The Service serves the real session route; this one 404s outside dev.
 */
export default defineEventHandler((event) => {
  assertDevMock(event)
  return { authenticated: true, bootstrapKind: 'passkey', surface: { _tag: 'Dashboard' }, passkeys: true }
})
