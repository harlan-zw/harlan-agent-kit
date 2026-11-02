import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createVitalsEvidenceDirectory } from '../src/vitals-comparison-runtime.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const request = {
  id: '5b7a9978-6b09-4d3e-a978-bebef7e65091',
  taskId: 'a'.repeat(64),
  revisionId: 'b'.repeat(64),
  baseSha: 'c'.repeat(40),
  issuedAt: '2026-11-02T05:00:00.000Z',
  targets: [{ path: '/tools/schema-validator', strategy: 'mobile' as const, metric: 'lcp' as const }],
}

async function home() {
  const directory = await mkdtemp(join(tmpdir(), 'vitals-controller-home-'))
  roots.push(directory)
  return directory
}

describe('retained vitals evidence allocation', () => {
  it('refuses to reuse an earlier comparison directory', async () => {
    const controller = await home()
    const directory = await createVitalsEvidenceDirectory(controller, request)
    await writeFile(join(directory, 'sample.json'), '{"retained":true}')

    await expect(createVitalsEvidenceDirectory(controller, request)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(JSON.parse(await readFile(join(directory, 'sample.json'), 'utf8'))).toEqual({ retained: true })
  })

  it('allocates a separate private directory for a fresh correction request', async () => {
    const controller = await home()
    const directory = await createVitalsEvidenceDirectory(controller, request)
    const correction = await createVitalsEvidenceDirectory(controller, { ...request, id: '6b7a9978-6b09-4d3e-a978-bebef7e65092' })
    expect(correction).not.toBe(directory)
    expect((await stat(correction)).mode & 0o777).toBe(0o700)
  })

  it('refuses a symlink ancestor without writing through it', async () => {
    const controller = await home()
    const protectedDirectory = await home()
    await symlink(protectedDirectory, join(controller, 'scratch'))

    await expect(createVitalsEvidenceDirectory(controller, request)).rejects.toMatchObject({ code: expect.stringMatching(/ELOOP|ENOTDIR/) })
    await expect(stat(join(protectedDirectory, 'vitals-review'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a directory another local user can write', async () => {
    const controller = await home()
    await mkdir(join(controller, 'scratch'), { mode: 0o777 })
    // mkdir follows the current umask, so make the unsafe boundary explicit.
    await chmod(join(controller, 'scratch'), 0o777)

    await expect(createVitalsEvidenceDirectory(controller, request)).rejects.toThrow('reject other writers')
  })

  it.each(['../outside', '/tmp/outside', 'task\0suffix'])('refuses an untrusted task path %s before creating it', async (taskId) => {
    const controller = await home()

    await expect(createVitalsEvidenceDirectory(controller, { ...request, taskId })).rejects.toThrow()
    await expect(stat(join(controller, 'scratch'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
