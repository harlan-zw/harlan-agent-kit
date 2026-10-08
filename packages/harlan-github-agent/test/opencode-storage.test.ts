import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { opencodeTaskKey, prepareOpencodeTaskDirectory } from '../src/opencode-storage.ts'

it('keeps Task storage outside aliases in controller-owned parents', async () => {
  const home = await mkdtemp(join(tmpdir(), 'opencode-storage-'))
  try {
    await mkdir(join(home, 'other'))
    await symlink(join(home, 'other'), join(home, '.local'))
    await expect(prepareOpencodeTaskDirectory(home, opencodeTaskKey('task'))).rejects.toThrow()
    await expect(prepareOpencodeTaskDirectory(home, '../escape')).rejects.toThrow('Task key')
  }
  finally {
    await rm(home, { recursive: true, force: true })
  }
})
