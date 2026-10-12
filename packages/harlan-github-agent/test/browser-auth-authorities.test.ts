import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createBrowserAuthorities } from '../src/browser-auth-authorities.ts'

it('identifies both configured private and public browser authorities as a Dashboard', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dashboard-authority-'))
  const authorities = createBrowserAuthorities({ directory, origin: 'https://private.example.com', publicOrigin: 'https://agent.example.com', privateTerminalHost: false, password: 'fixture', now: Date.now })
  try {
    for (const authority of [authorities.private, authorities.public!]) {
      const response = await authority.handle(new Request(`${authority.origin}/api/browser-auth/session`, { headers: { host: new URL(authority.origin).host } }))
      expect(await response?.json()).toMatchObject({ surface: { _tag: 'Dashboard' }, authenticated: false })
    }
  }
  finally {
    authorities.close()
    rmSync(directory, { recursive: true })
  }
})
it('retains configured private terminals while refusing their discovery on public ingress', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dashboard-authority-'))
  const authorities = createBrowserAuthorities({ directory, origin: 'https://private.example.com', publicOrigin: 'https://agent.example.com', privateTerminalHost: true, password: 'fixture', now: Date.now })
  try {
    const session = async (authority: typeof authorities.private) => (await authority.handle(new Request(`${authority.origin}/api/browser-auth/session`, { headers: { host: new URL(authority.origin).host } })))!.json()
    expect(await session(authorities.private)).toMatchObject({ surface: { _tag: 'TerminalHost' } })
    expect(await session(authorities.public!)).toMatchObject({ surface: { _tag: 'Dashboard' } })
  }
  finally {
    authorities.close()
    rmSync(directory, { recursive: true })
  }
})
