import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const build = promisify(execFile)
const packageDir = fileURLToPath(new URL('.', import.meta.url))

it('build mode serves non-Markdown assets beside their notes', async () => {
  const notes = await mkdtemp(join(tmpdir(), 'notes-viewer-build-'))
  await writeFile(join(notes, 'report.md'), '# Report\n\nSee the [manual](./manual.pdf).\n')
  await writeFile(join(notes, 'manual.pdf'), '%PDF-1.4\n')
  try {
    await build('node', ['start.mjs', 'build'], {
      cwd: packageDir,
      env: { ...process.env, NOTES_DIR: notes },
    })
    expect(existsSync(join(packageDir, '.vitepress/dist/notes/manual.pdf'))).toBe(true)
  }
  finally {
    await rm(notes, { recursive: true, force: true })
  }
}, 120_000)
