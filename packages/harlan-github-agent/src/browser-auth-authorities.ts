import { createHash, timingSafeEqual } from 'node:crypto'
import { lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openBrowserAuthStore } from './browser-auth-store.ts'
import { createBrowserAuth } from './browser-auth.ts'

/** The public proxy identity is configured, never inferred from forwarded headers. */
export function createBrowserAuthorities(options: { directory: string, origin: string, publicOrigin?: string, password: string, now: () => number }) {
  const stores: ReturnType<typeof openBrowserAuthStore>[] = []
  function authority(origin: string) {
    const path = join(options.directory, createHash('sha256').update(origin).digest('hex'))
    mkdirSync(options.directory, { recursive: true, mode: 0o700 })
    mkdirSync(path, { recursive: true, mode: 0o700 })
    const store = openBrowserAuthStore(join(path, 'auth.sqlite'))
    stores.push(store)
    return createBrowserAuth({ origin, rpId: new URL(origin).hostname, store, now: options.now, bootstrapKind: 'password', bootstrap: (body) => {
      if (typeof body.password !== 'string')
        return false
      const supplied = Buffer.from(body.password)
      const expected = Buffer.from(options.password)
      return supplied.length === expected.length && timingSafeEqual(supplied, expected)
    } })
  }
  // Existing directories must retain the same private ownership on restart.
  mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  const metadata = lstatSync(options.directory)
  if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0)
    throw new Error('Browser authentication requires a private directory')
  const privateAuthority = authority(options.origin)
  const publicAuthority = options.publicOrigin ? authority(options.publicOrigin) : undefined
  return { private: privateAuthority, ...(publicAuthority ? { public: publicAuthority } : {}), close() {
    for (const store of stores)
      store.close()
  } }
}
