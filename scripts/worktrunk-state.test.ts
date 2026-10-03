import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

it('seeds writable state without copying generated Nuxt paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'worktrunk-state-'))
  roots.push(root)
  const primary = join(root, 'primary')
  const workspace = join(root, 'workspace')
  mkdirSync(primary)
  mkdirSync(workspace)
  spawnSync('git', ['init', '--quiet', primary])
  writeFileSync(join(primary, '.gitignore'), '.data/\n.wrangler/\n.nuxt/\n')
  for (const path of ['.data', '.wrangler/state', '.nuxt', 'app/.nuxt', '-port/.nuxt']) {
    mkdirSync(join(primary, path), { recursive: true })
    writeFileSync(join(primary, path, 'evidence'), path)
  }
  const config = readFileSync(new URL('./worktrunk.toml', import.meta.url), 'utf8')
  const command = /state = """\n([\s\S]*?)"""/.exec(config)![1]!
    .replaceAll('{{ primary_worktree_path }}', primary)
  const result = spawnSync('bash', ['-c', command], { cwd: workspace, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  expect(readFileSync(join(workspace, '.data/evidence'), 'utf8')).toBe('.data')
  expect(readFileSync(join(workspace, '.wrangler/state/evidence'), 'utf8')).toBe('.wrangler/state')
  expect(existsSync(join(workspace, '.nuxt'))).toBe(false)
  expect(existsSync(join(workspace, 'app/.nuxt'))).toBe(false)
  expect(existsSync(join(workspace, '-port/.nuxt'))).toBe(false)
})
