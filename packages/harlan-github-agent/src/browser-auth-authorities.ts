import type { BrowserWebAuthn } from './browser-auth.ts'
import type { Result } from './result.ts'
import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { openBrowserAuthStore } from './browser-auth-store.ts'
import { createBrowserAuth, hashBrowserToken } from './browser-auth.ts'
import { err, ok } from './result.ts'

const pairingMilliseconds = 5 * 60 * 1000

/** Each browser origin keeps its own Passkeys, because the RP ID is the hostname. */
export function browserAuthStorePath(directory: string, origin: string) {
  return join(directory, createHash('sha256').update(origin).digest('hex'), 'auth.sqlite')
}

function openOriginStore(directory: string, origin: string) {
  // Existing directories must retain the same private ownership on restart.
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const metadata = lstatSync(directory)
  if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0)
    throw new Error('Browser authentication requires a private directory')
  const path = browserAuthStorePath(directory, origin)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  return openBrowserAuthStore(path)
}

/** The origin and store directory that `pair` writes to. Only a configured, persistent origin qualifies. */
export function pairingTarget(config: { storage: { path: string }, server: { allowedOrigin: string, browserOrigins?: readonly string[] } }, requested: string | undefined): Result<{ directory: string, origin: string }, string> {
  const origins = [config.server.allowedOrigin, ...config.server.browserOrigins ?? []]
  const origin = requested !== undefined && URL.canParse(requested) ? new URL(requested).origin : undefined
  if (origin === undefined || !origins.includes(origin))
    return err(`Choose a configured origin with --origin: ${origins.join(', ')}.`)
  if (config.storage.path === ':memory:')
    return err('Pairing links require persistent storage.')
  return ok({ directory: join(dirname(config.storage.path), 'browser-auth'), origin })
}

/** The host command to run when an origin has no Passkey. */
export function pairingCommand(origin: string, configPath?: string) {
  return `harlan-github-agent pair --origin ${origin}${configPath === undefined ? '' : ` --config ${configPath}`}`
}

/**
 * Write a single-use pairing secret for one origin, valid for five minutes.
 * The Service redeems it from the same store. The secret travels in the URL
 * fragment, so it never reaches a request log.
 */
export function createPairingLink(options: { directory: string, origin: string, now: () => number }): Result<{ url: string, expires: number }, string> {
  const store = openOriginStore(options.directory, options.origin)
  try {
    const token = randomBytes(32).toString('base64url')
    const expires = options.now() + pairingMilliseconds
    if (!store.pairing({ hash: hashBrowserToken(token), expires }, options.now()))
      return err('Too many pairing links are open for this origin. Wait five minutes, then retry.')
    return ok({ url: `${options.origin}/#pair=${token}`, expires })
  }
  finally {
    store.close()
  }
}

/**
 * Every Service origin is Passkey-only. A pairing link from the host adds the
 * first Passkey, or a new one after every Passkey is lost.
 * The public proxy identity is configured, never inferred from forwarded headers.
 */
export function createBrowserAuthorities(options: { directory: string, origin: string, publicOrigin?: string, publicTerminalHost?: boolean, privateTerminalHost: boolean, now: () => number, webauthn?: BrowserWebAuthn }) {
  if (options.publicTerminalHost && (!options.publicOrigin || !options.privateTerminalHost))
    throw new Error('Public terminals require private Agent sessions and one public browser origin.')
  const stores: ReturnType<typeof openBrowserAuthStore>[] = []
  function authority(origin: string, terminalHost: boolean) {
    const store = openOriginStore(options.directory, origin)
    stores.push(store)
    return createBrowserAuth({
      origin,
      rpId: new URL(origin).hostname,
      store,
      now: options.now,
      ...(options.webauthn ? { webauthn: options.webauthn } : {}),
      surface: { _tag: terminalHost ? 'TerminalHost' : 'Dashboard' },
      bootstrapKind: 'passkey',
      bootstrap: body => typeof body.token === 'string' && /^[\w-]{32,256}$/.test(body.token) && store.redeemPairing(hashBrowserToken(body.token), options.now()),
    })
  }
  const privateAuthority = authority(options.origin, options.privateTerminalHost)
  const publicAuthority = options.publicOrigin ? authority(options.publicOrigin, options.publicTerminalHost === true) : undefined
  return { private: privateAuthority, ...(publicAuthority ? { public: publicAuthority } : {}), close() {
    for (const store of stores)
      store.close()
  } }
}
