import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadDashboardPassword } from '../src/dashboard-password.ts'

const directories: string[] = []

afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('dashboard password', () => {
  it('loads the saved password without its trailing newline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harlan-agent-password-'))
    directories.push(directory)
    const path = join(directory, 'dashboard-password')
    await writeFile(path, `${'a'.repeat(48)}\n`, { mode: 0o600 })

    expect(await loadDashboardPassword(path)).toEqual({ _tag: 'Ok', value: 'a'.repeat(48) })
  })

  it('rejects a short saved password', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harlan-agent-password-'))
    directories.push(directory)
    const path = join(directory, 'dashboard-password')
    await writeFile(path, 'short\n', { mode: 0o600 })

    expect(await loadDashboardPassword(path)).toEqual({
      _tag: 'Err',
      error: 'The dashboard password file must contain at least 32 bytes.',
    })
  })
})
