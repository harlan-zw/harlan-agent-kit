import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listTerminalDiff, readTerminalDiff } from '../src/terminal-diff.ts'

const directories: string[] = []
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'terminal-diff-'))
  directories.push(root)
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  await writeFile(join(root, 'file.txt'), 'before\n')
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root })
  return root
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('read-only terminal diffs', () => {
  it('refuses malformed revision lengths before reading a repository', async () => {
    for (const length of [39, 41, 48, 63, 65]) {
      expect(
        await listTerminalDiff('/missing-repository', {
          _tag: 'Comparison',
          base: 'a'.repeat(length),
          head: 'b'.repeat(40),
        }),
      ).toEqual({ _tag: 'Err', error: 'InvalidRequest' })
    }
  })

  it('keeps staged and working contents distinct and includes NUL-safe untracked names', async () => {
    const root = await repository()
    await writeFile(join(root, 'file.txt'), 'staged\n')
    execFileSync('git', ['add', '.'], { cwd: root })
    await writeFile(join(root, 'file.txt'), 'working\n')
    await writeFile(join(root, 'new\nfile.txt'), 'new\n')
    const working = await listTerminalDiff(root, { _tag: 'Working' })
    expect(working._tag).toBe('Ok')
    if (working._tag !== 'Ok') return
    expect(working.value.files.map((file) => file.path)).toContain('new\nfile.txt')
    const current = await readTerminalDiff(root, working.value, 'file.txt')
    expect(current).toMatchObject({ _tag: 'Ok', value: { oldText: 'before\n', newText: 'working\n' } })
    const staged = await listTerminalDiff(root, { _tag: 'Staged' })
    if (staged._tag !== 'Ok') throw new Error('Expected staged snapshot')
    execFileSync('git', ['add', 'file.txt'], { cwd: root })
    expect(await readTerminalDiff(root, staged.value, 'file.txt')).toMatchObject({
      _tag: 'Ok',
      value: { newText: 'staged\n' },
    })
  })

  it('refuses outside paths, symlinks, binaries, and changed working files', async () => {
    const root = await repository()
    await writeFile(join(root, 'binary'), Buffer.from([0, 1, 2]))
    await symlink('/etc/passwd', join(root, 'link'))
    await writeFile(join(root, 'file.txt'), 'first\n')
    const snapshot = await listTerminalDiff(root, { _tag: 'Working' })
    if (snapshot._tag !== 'Ok') throw new Error('Expected snapshot')
    expect(await readTerminalDiff(root, snapshot.value, '../etc/passwd')).toMatchObject({
      _tag: 'Err',
      error: 'InvalidRequest',
    })
    expect(await readTerminalDiff(root, snapshot.value, 'link')).toMatchObject({ _tag: 'Err', error: 'Symlink' })
    expect(await readTerminalDiff(root, snapshot.value, 'binary')).toMatchObject({ _tag: 'Err', error: 'Binary' })
    await writeFile(join(root, 'file.txt'), 'second longer\n')
    expect(await readTerminalDiff(root, snapshot.value, 'file.txt')).toMatchObject({ _tag: 'Err', error: 'Changed' })
  })

  it('never invokes configured clean filters or external diff programs', async () => {
    const root = await repository()
    const marker = join(root, 'executed')
    await writeFile(join(root, '.gitattributes'), '*.txt filter=unsafe diff=unsafe\n')
    execFileSync('git', ['config', 'filter.unsafe.clean', `touch '${marker}'`], { cwd: root })
    execFileSync('git', ['config', 'diff.unsafe.command', `touch '${marker}'`], { cwd: root })
    await writeFile(join(root, 'file.txt'), 'changed\n')
    const snapshot = await listTerminalDiff(root, { _tag: 'Working' })
    if (snapshot._tag !== 'Ok') throw new Error('Expected snapshot')
    expect(await readTerminalDiff(root, snapshot.value, 'file.txt')).toMatchObject({ _tag: 'Ok' })
    expect(existsSync(marker)).toBe(false)
  })

  it('pins immutable comparison revisions', async () => {
    const root = await repository()
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    await writeFile(join(root, 'file.txt'), 'committed\n')
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['commit', '-qm', 'next'], { cwd: root })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const snapshot = await listTerminalDiff(root, { _tag: 'Comparison', base, head })
    if (snapshot._tag !== 'Ok') throw new Error('Expected snapshot')
    await mkdir(join(root, 'other'))
    await writeFile(join(root, 'file.txt'), 'uncommitted\n')
    expect(await readTerminalDiff(root, snapshot.value, 'file.txt')).toMatchObject({
      _tag: 'Ok',
      value: { oldText: 'before\n', newText: 'committed\n' },
    })
  })
})
