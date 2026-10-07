import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createReviewProviderHome } from '../src/review-provider-home.ts'

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
