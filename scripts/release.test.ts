import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterEach, expect, it, vi } from 'vitest'

// Git subprocesses need the same timeout as the Service integration tests.
vi.setConfig({ testTimeout: 30_000 })

const script = resolve('scripts/release.ts')
const fixtures: string[] = []

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'release-preview-'))
  fixtures.push(cwd)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim()
  git('init', '--quiet')
  git('config', 'user.name', 'Release test')
  git('config', 'user.email', 'release@example.com')
  for (const dir of ['harlan-agent-kit/.claude-plugin', 'harlan-agent-kit/.codex-plugin', '.claude-plugin'])
    mkdirSync(join(cwd, dir), { recursive: true })
  for (const dir of ['.claude-plugin', '.codex-plugin'])
    writeFileSync(join(cwd, 'harlan-agent-kit', dir, 'plugin.json'), JSON.stringify({ version: '1.0.0' }))
  writeFileSync(join(cwd, '.claude-plugin/marketplace.json'), JSON.stringify({ plugins: [{ version: '1.0.0' }] }))
  git('add', '.')
  git('commit', '--quiet', '-m', 'chore: initial release')
  const commit = (message: string) => git('commit', '--quiet', '--allow-empty', '-m', message)
  const preview = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', script, ...args], { cwd, encoding: 'utf8' })
  return { cwd, git, commit, preview }
}

afterEach(() => {
  for (const path of fixtures.splice(0))
    rmSync(path, { recursive: true, force: true })
})

it('groups only unreleased commits and leaves the repository unchanged', () => {
  const { git, commit, preview } = fixture()
  git('tag', 'v1.0.0')
  commit('feat(cli): add preview')
  commit('fix: repair output')
  commit('chore: update tools')
  commit('docs: explain usage')
  commit('Refresh examples')
  const head = git('rev-parse', 'HEAD')
  const result = preview('minor', '--dry-run')
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('v1.0.0 → v1.1.0')
  expect(result.stdout).toMatch(/feat \(1\)[\s\S]*feat\(cli\): add preview/)
  expect(result.stdout).toMatch(/fix \(1\)[\s\S]*fix: repair output/)
  expect(result.stdout).toMatch(/chore \(1\)[\s\S]*chore: update tools/)
  expect(result.stdout).toMatch(/docs \(1\)[\s\S]*docs: explain usage/)
  expect(result.stdout).toMatch(/other \(1\)[\s\S]*Refresh examples/)
  expect(result.stdout).not.toContain('initial release')
  expect(git('rev-parse', 'HEAD')).toBe(head)
  expect(git('status', '--porcelain')).toBe('')
  expect(git('tag', '--list')).toBe('v1.0.0')
})

it('puts breaking markers and footers first without duplicating commits', () => {
  const { git, commit, preview } = fixture()
  git('tag', 'v1.0.0')
  commit('feat(api)!: remove old API')
  commit('fix: change defaults\n\nBREAKING CHANGE: configure the new default')
  commit('chore: remove option\n\nBREAKING-CHANGE: use the replacement')
  const result = preview('major', '--dry-run')
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('breaking change (3)')
  expect(result.stdout).toContain('configure the new default')
  expect(result.stdout).toContain('use the replacement')
  expect(result.stdout.match(/remove old API/g)).toHaveLength(1)
  expect(result.stdout).not.toContain('\nfeat (')
  expect(result.stdout).not.toContain('\nfix (')
})

it('uses the nearest reachable release tag, ignoring unrelated tags', () => {
  const { git, commit, preview } = fixture()
  git('tag', 'v0.9.0')
  commit('feat: released already')
  git('tag', 'v1.0.0')
  commit('fix: pending change')
  git('tag', 'deployment')
  const result = preview('patch', '--dry-run')
  expect(result.stdout).toContain('Commits: v1.0.0..HEAD')
  expect(result.stdout).toContain('pending change')
  expect(result.stdout).not.toContain('released already')
})

it('shows initial history when no release tag exists and explains empty releases', () => {
  const { git, preview } = fixture()
  expect(preview('patch', '--dry-run').stdout).toContain('chore: initial release')
  git('tag', 'v1.0.0')
  expect(preview('patch', '--dry-run').stdout).toContain('No commits since v1.0.0.')
})

it('shows uncommitted paths without changing them during a dry run', () => {
  const { cwd, git, preview } = fixture()
  writeFileSync(join(cwd, 'pending.txt'), 'pending')
  const before = git('status', '--porcelain')
  expect(preview('patch', '--dry-run').stdout).toContain('?? pending.txt')
  expect(git('status', '--porcelain')).toBe(before)
})

it('prints the preview before releasing and pushes the new version to a local remote', () => {
  const { git, commit, preview } = fixture()
  const remote = mkdtempSync(join(tmpdir(), 'release-remote-'))
  fixtures.push(remote)
  execFileSync('git', ['init', '--quiet', '--bare', remote])
  git('config', 'core.hooksPath', '/dev/null')
  git('remote', 'add', 'origin', remote)
  git('push', '--quiet', '-u', 'origin', 'HEAD')
  git('tag', 'v1.0.0')
  commit('feat: add release preview')
  const result = preview('minor')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('feat (1)')
  expect(result.stdout.indexOf('feat (1)')).toBeLessThan(result.stdout.indexOf('Bumping'))
  expect(result.stdout).toContain('Released v1.1.0')
  const manifest = execFileSync('git', ['--git-dir', remote, 'show', 'v1.1.0:harlan-agent-kit/.claude-plugin/plugin.json'], { encoding: 'utf8' })
  expect(JSON.parse(manifest).version).toBe('1.1.0')
  expect(git('status', '--porcelain')).toBe('')
})
