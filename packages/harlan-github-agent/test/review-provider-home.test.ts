import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createReviewProviderHome } from '../src/review-provider-home.ts'

it.each(['codex', 'opencode'] as const)('saves refreshed %s auth without copying executable configuration', async (provider) => {
  const root = await mkdtemp(join(tmpdir(), 'review-login-refresh-'))
  try {
    const worker = join(root, 'worker')
    const auth = provider === 'codex' ? '.codex/auth.json' : '.local/share/opencode/auth.json'
    await Promise.all([mkdir(join(worker, '.codex'), { recursive: true }), mkdir(join(worker, '.local/share/opencode'), { recursive: true })])
    await writeFile(join(worker, auth), '{"tokens":{"refresh_token":"fixture-original"}}')
    const profilePath = join(root, 'worker.json')
    await writeFile(profilePath, JSON.stringify({ home: worker }))
    const home = await createReviewProviderHome({ profilePath, provider, configuration: provider === 'codex' ? '' : '{}' })
    await writeFile(join(home.home, auth), '{"tokens":{"refresh_token":"fixture-refreshed"}}')
    await writeFile(join(home.home, 'malicious-plugin.ts'), 'throw new Error("model plugin")')
    await home.release()
    expect(await readFile(join(worker, auth), 'utf8')).toBe('{"tokens":{"refresh_token":"fixture-refreshed"}}')
    await expect(readFile(join(worker, 'malicious-plugin.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('preserves a newer destination login and returns a clear conflict warning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-login-conflict-'))
  try {
    const worker = join(root, 'worker')
    await mkdir(join(worker, '.codex'), { recursive: true })
    await writeFile(join(worker, '.codex/auth.json'), '{"tokens":{"refresh_token":"fixture-original"}}')
    const profilePath = join(root, 'worker.json')
    await writeFile(profilePath, JSON.stringify({ home: worker }))
    const home = await createReviewProviderHome({ profilePath, provider: 'codex', configuration: '' })
    await writeFile(join(home.home, '.codex/auth.json'), '{"tokens":{"refresh_token":"fixture-stale-review"}}')
    await writeFile(join(worker, '.codex/auth.json'), '{"tokens":{"refresh_token":"fixture-newer"}}')
    expect(await home.release()).toEqual({ _tag: 'Released', warnings: ['The Review login changed concurrently. The controller preserved the current login.'] })
    expect(await readFile(join(worker, '.codex/auth.json'), 'utf8')).toContain('fixture-newer')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('serializes concurrent Review refreshes and preserves the first saved login', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-login-concurrent-'))
  try {
    const worker = join(root, 'worker')
    await mkdir(join(worker, '.codex'), { recursive: true })
    await writeFile(join(worker, '.codex/auth.json'), '{"login":"fixture-original"}')
    const profilePath = join(root, 'worker.json')
    await writeFile(profilePath, JSON.stringify({ home: worker }))
    const homes = await Promise.all([0, 1].map(() => createReviewProviderHome({ profilePath, provider: 'codex', configuration: '' })))
    await Promise.all(homes.map((home, index) => writeFile(join(home.home, '.codex/auth.json'), JSON.stringify({ login: `fixture-${index}` }))))
    const outcomes = await Promise.all(homes.map(home => home.release()))
    expect(outcomes.filter(outcome => outcome.warnings.length === 0)).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.warnings.length === 1)).toHaveLength(1)
    expect(JSON.parse(await readFile(join(worker, '.codex/auth.json'), 'utf8')).login).toMatch(/^fixture-[01]$/)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['symlink', 'oversize'] as const)('rejects a %s refreshed login and preserves the named worker login', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'review-login-invalid-'))
  try {
    const worker = join(root, 'worker')
    await mkdir(join(worker, '.codex'), { recursive: true })
    await writeFile(join(worker, '.codex/auth.json'), '{"login":"fixture-original"}')
    const profilePath = join(root, 'worker.json')
    await writeFile(profilePath, JSON.stringify({ home: worker }))
    const home = await createReviewProviderHome({ profilePath, provider: 'codex', configuration: '' })
    const path = join(home.home, '.codex/auth.json')
    if (kind === 'symlink') {
      await rm(path)
      await writeFile(join(root, 'fake-secret'), 'fake-controller-secret')
      await symlink(join(root, 'fake-secret'), path)
    }
    else {
      await writeFile(path, 'x'.repeat(100_001))
    }
    await expect(home.release()).rejects.toThrow()
    expect(await readFile(join(worker, '.codex/auth.json'), 'utf8')).toBe('{"login":"fixture-original"}')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects a replaced login directory before writing a fake controller secret', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-login-alias-'))
  try {
    const worker = join(root, 'worker')
    const secret = join(root, 'controller')
    await Promise.all([mkdir(join(worker, '.codex'), { recursive: true }), mkdir(secret)])
    await writeFile(join(worker, '.codex/auth.json'), '{"login":"fixture-original"}')
    await writeFile(join(secret, 'auth.json'), 'fake-controller-secret')
    const profilePath = join(root, 'worker.json')
    await writeFile(profilePath, JSON.stringify({ home: worker }))
    const home = await createReviewProviderHome({ profilePath, provider: 'codex', configuration: '' })
    await writeFile(join(home.home, '.codex/auth.json'), '{"login":"fixture-refreshed"}')
    await rm(join(worker, '.codex'), { recursive: true })
    await symlink(secret, join(worker, '.codex'))
    await expect(home.release()).rejects.toThrow()
    expect(await readFile(join(secret, 'auth.json'), 'utf8')).toBe('fake-controller-secret')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps Review provider configuration separate from inherited executable tools and plugins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-provider-home-'))
  try {
    const workerHome = join(root, 'worker')
    await mkdir(join(workerHome, '.codex'), { recursive: true })
    await writeFile(join(workerHome, '.codex/auth.json'), '{"login":"fixture-only"}')
    await writeFile(join(workerHome, '.codex/config.toml'), '[mcp_servers.escape]\ncommand="bash"')
    const profilePath = join(root, 'worker.json')
    await writeFile(profilePath, JSON.stringify({ home: workerHome }))
    const isolated = await createReviewProviderHome({ profilePath, provider: 'codex', configuration: 'shell_tool = false' })
    try {
      expect(await readdir(join(isolated.home, '.codex'))).toEqual(['auth.json', 'config.toml'])
      expect(await readFile(join(isolated.home, '.codex/config.toml'), 'utf8')).toBe('shell_tool = false')
      expect(await readFile(join(isolated.home, '.codex/auth.json'), 'utf8')).toBe('{"login":"fixture-only"}')
    }
    finally {
      await isolated.release()
    }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('copies only the named OpenCode login instead of executable provider settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-provider-config-'))
  try {
    const workerHome = join(root, 'worker')
    await mkdir(join(workerHome, '.config/opencode'), { recursive: true })
    await writeFile(join(workerHome, '.config/opencode/opencode.json'), JSON.stringify({ provider: { 'zai-coding-plan': { npm: 'file:/tmp/escape', options: { apiKey: 'fixture-only', baseURL: 'http://127.0.0.1' } }, 'escape': { npm: 'file:/tmp/escape' } } }))
    const profilePath = join(root, 'worker.json')
    await writeFile(profilePath, JSON.stringify({ home: workerHome }))
    const isolated = await createReviewProviderHome({ profilePath, provider: 'opencode', configuration: '{"permission":{"*":"deny"}}' })
    try {
      const configured = JSON.parse(await readFile(join(isolated.home, '.config/opencode/opencode.json'), 'utf8'))
      expect(configured).toEqual({ permission: { '*': 'deny' }, provider: { 'zai-coding-plan': { options: { apiKey: 'fixture-only' } } } })
    }
    finally {
      await isolated.release()
    }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
