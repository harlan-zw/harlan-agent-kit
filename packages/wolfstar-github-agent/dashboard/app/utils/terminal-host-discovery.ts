import type { TerminalCapabilities } from '../../../src/terminal-protocol.ts'
import { parseTerminalCapabilities } from './terminal-protocol.ts'

export type BrowserSurface = { _tag: 'Dashboard' } | { _tag: 'TerminalHost' }
export type HostState =
  | { _tag: 'Checking' }
  | { _tag: 'Dashboard' }
  | { _tag: 'Available'; capabilities: TerminalCapabilities }
  | { _tag: 'Legacy' }
  | { _tag: 'PairingRequired' }
  | { _tag: 'Unavailable' }
export async function discoverTerminalHost(
  surface: BrowserSurface,
  capabilities: () => Promise<unknown>,
): Promise<HostState> {
  if (surface._tag === 'Dashboard') return { _tag: 'Dashboard' }
  return Promise.resolve()
    .then(capabilities)
    .then((value): HostState => {
      const parsed = parseTerminalCapabilities(value)
      return parsed._tag === 'Ok' ? { _tag: 'Available', capabilities: parsed.value } : { _tag: 'Unavailable' }
    })
    .catch((error: unknown) => {
      const status =
        typeof error === 'object' && error !== null
          ? 'statusCode' in error
            ? error.statusCode
            : 'status' in error
              ? error.status
              : undefined
          : undefined
      return status === 404
        ? { _tag: 'Legacy' }
        : status === 401 || status === 403
          ? { _tag: 'PairingRequired' }
          : { _tag: 'Unavailable' }
    })
}
