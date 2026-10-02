import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'public-gh-'))
  roots.push(root)
  const config = join(root, '.config/harlan-agent-kit')
  const bin = join(root, '.local/bin')
  mkdirSync(config, { recursive: true })
  mkdirSync(bin, { recursive: true })
  const token = join(config, 'github-public-token')
  writeFileSync(token, 'github_pat_fixture', { mode: 0o600 })
  const recorded = join(root, 'request')
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
[ "$GH_TOKEN" = github_pat_fixture ] || exit 91
[ "$GH_HOST" = github.com ] || exit 92
[ "$GH_CONFIG_DIR" = "$HOME/.config/harlan-agent-kit/gh-public" ] || exit 93
[ -z "\${GITHUB_TOKEN:-}" ] || exit 94
printf '%s\n' "$@" > "$RECORD"
exit "\${RESULT:-0}"
`, { mode: 0o755 })
  return {
    token,
    recorded,
    run: (args: string[], extra: Record<string, string> = {}) => spawnSync('bash', [resolve('scripts/github-public.sh'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin`, GH_TOKEN: 'personal', GITHUB_TOKEN: 'personal', GH_HOST: 'other.example', GH_CONFIG_DIR: '/personal', RECORD: recorded, ...extra },
    }),
  }
}

describe('public GitHub CLI access', () => {
  it('uses the agent credential rather than inherited personal credentials', () => {
    const f = fixture()
    expect(f.run(['pr', 'view', '123', '--repo', 'owner/repo']).status).toBe(0)
    expect(readFileSync(f.recorded, 'utf8')).toBe('pr\nview\n123\n--repo\nowner/repo\n')
  })

  it('keeps API field requests on GET', () => {
    const f = fixture()
    expect(f.run(['api', 'repos/owner/repo/issues', '-f', 'state=open']).status).toBe(0)
    expect(readFileSync(f.recorded, 'utf8')).toContain('--method\nGET\n')
  })

  it.each([
    ['pr', 'create'],
    ['pr', 'merge', '123'],
    ['issue', 'comment', '1'],
    ['run', 'rerun', '1'],
    ['auth', 'token'],
    ['alias', 'set', 'x', 'pr merge'],
    ['api', 'graphql', '-f', 'query=query { viewer { login } }'],
    ['api', 'repos/owner/repo', '-X', 'DELETE'],
    ['api', 'repos/owner/repo', '-XPOST'],
    ['api', 'https://other.example/path'],
    ['api', '//other.example/path'],
    ['api', 'repos/owner/repo', '--hostname', 'other.example'],
    ['api', 'repos/owner/repo', '-H', 'Authorization: token personal'],
    ['api', 'repos/owner/repo', '--header=Authorization: token personal'],
    ['pr', 'view', '1', '--web'],
  ])('refuses unsafe requests: %s %s', (...args) => {
    const f = fixture()
    expect(f.run(args).status).toBe(1)
    expect(() => readFileSync(f.recorded)).toThrow()
  })

  it('does not fall back when the token is missing or readable by others', () => {
    const f = fixture()
    chmodSync(f.token, 0o644)
    expect(f.run(['api', 'user']).status).toBe(1)
    rmSync(f.token)
    expect(f.run(['api', 'user']).status).toBe(1)
    expect(() => readFileSync(f.recorded)).toThrow()
  })

  it('passes failures through without switching credentials', () => {
    const f = fixture()
    expect(f.run(['api', 'repos/private/repo'], { RESULT: '4' }).status).toBe(4)
  })
})
