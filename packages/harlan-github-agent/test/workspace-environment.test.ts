import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
    expect(parseEnvironmentFile('LD_AUDIT=/tmp/evil.so\nLD_LIBRARY_PATH=/x\nLD_PRELOAD=/y\nOK=1\n'))
      .toEqual({ OK: '1' })
    expect(parseEnvironmentFile('BASH_ENV=./pwn.sh\nENV=./pwn.sh\nOK=1\n'))
      .toEqual({ OK: '1' })
    expect(parseEnvironmentFile('NODE_PATH=/tmp/evil\nOK=1\n'))
      .toEqual({ OK: '1' })
    expect(parseEnvironmentFile('DYLD_INSERT_LIBRARIES=/tmp/evil.dylib\nDYLD_LIBRARY_PATH=/x\nOK=1\n'))
      .toEqual({ OK: '1' })
  })

  it('refuses names that redirect network traffic or replace certificate trust', () => {
    expect(parseEnvironmentFile('HTTPS_PROXY=http://evil:8080\nSSL_CERT_FILE=./ca.pem\nNODE_EXTRA_CA_CERTS=./ca.pem\nOK=1\n'))
      .toEqual({ OK: '1' })
    expect(parseEnvironmentFile('HTTP_PROXY=http://evil:8080\nALL_PROXY=socks5://evil:1080\nNO_PROXY=api.github.com\nSSL_CERT_DIR=./ca\nCURL_CA_BUNDLE=./ca.pem\nREQUESTS_CA_BUNDLE=./ca.pem\nGITHUB_API_URL=http://evil\nOK=1\n'))
      .toEqual({ OK: '1' })
    expect(parseEnvironmentFile('https_proxy=http://evil:8080\nOK=1\n'))
      .toEqual({ OK: '1' })
  })

  it('refuses names that repoint tooling config directories', () => {
    expect(parseEnvironmentFile('XDG_CONFIG_HOME=./evil\nGH_CONFIG_DIR=./evil\nOK=1\n'))
      .toEqual({ OK: '1' })
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

  it('keeps the base environment when the .env path is not a readable file', () => {
    const base = { PATH: '/bin' }
    const workspace = mkdtempSync(join(tmpdir(), 'worktree-env-'))
    mkdirSync(join(workspace, '.env'))

    expect(workspaceEnvironment(base, workspace)).toBe(base)
  })
})
