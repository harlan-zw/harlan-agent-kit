import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseEnvironmentFile, workspaceEnvironment } from '../src/workspace-environment.ts'

describe('reading a repository environment file', () => {
  it('parses the shapes dotenv tooling writes', () => {
    expect(parseEnvironmentFile(`
# tokens
CLOUDFLARE_API_TOKEN=abc123
export NUXTSEO_TOKEN="nst_x y"
QUOTED='single # not a comment'
TRAILING=value # comment
MULTI="a\\nb"
BROKEN LINE
`)).toEqual({
      CLOUDFLARE_API_TOKEN: 'abc123',
      NUXTSEO_TOKEN: 'nst_x y',
      QUOTED: 'single # not a comment',
      TRAILING: 'value',
      MULTI: 'a\nb',
    })
  })

  it('refuses names that change how the Agent process runs', () => {
    expect(parseEnvironmentFile('PATH=/evil\nNODE_OPTIONS=--require x\nGIT_DIR=/x\nSENTRY_AUTH_TOKEN=ok\n'))
      .toEqual({ SENTRY_AUTH_TOKEN: 'ok' })
  })
})

describe('the environment one turn runs with', () => {
  it('layers the worktree .env over the service environment', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'worktree-env-'))
    writeFileSync(join(workspace, '.env'), 'CLOUDFLARE_API_TOKEN=repo\nONLY_HERE=1\n')

    expect(workspaceEnvironment({ PATH: '/bin', CLOUDFLARE_API_TOKEN: 'service' }, workspace))
      .toEqual({ PATH: '/bin', CLOUDFLARE_API_TOKEN: 'repo', ONLY_HERE: '1' })
  })

  it('keeps the same environment object when the worktree has no .env', () => {
    const base = { PATH: '/bin' }
    const workspace = mkdtempSync(join(tmpdir(), 'worktree-env-'))

    expect(workspaceEnvironment(base, workspace)).toBe(base)
  })
})
