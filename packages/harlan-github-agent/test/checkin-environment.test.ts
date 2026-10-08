import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { checkinEnvironment } from '../src/checkin-environment.ts'

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

async function fixture() {
  const controllerHome = await mkdtemp(join(tmpdir(), 'checkin-env-'))
  homes.push(controllerHome)
  await mkdir(join(controllerHome, '.config/harlan-checkin'), { recursive: true, mode: 0o700 })
  return { controllerHome, repository: 'owner/site', taskId: 'owner/site:daily-checkin:2026-10-08T00:00:00.000Z' }
}

it('keeps private collection values and preserves worker setup and archive ownership', async () => {
  const input = await fixture()
  await writeFile(join(input.controllerHome, '.config/harlan-checkin/site.env'), 'CHECKIN_TOKEN=private\nCI=false\nGH_TOKEN=secret\nHOME=/other\nXDG_STATE_HOME=/other\nDAILY_CHECKIN_DIR=/other\n', { mode: 0o600 })
  expect(await checkinEnvironment(input)).toEqual({ CHECKIN_TOKEN: 'private', CI: 'true' })
  expect(await checkinEnvironment({ ...input, taskId: 'review-task' })).toEqual({})
})

it('runs collection without a TTY even when the private file is missing', async () => {
  expect(await checkinEnvironment(await fixture())).toEqual({ CI: 'true' })
})

it('rejects credentials for another repository', async () => {
  await expect(checkinEnvironment({ ...await fixture(), repository: 'other/site' })).rejects.toThrow('repository')
})

it('rejects a credential file readable by other accounts', async () => {
  const input = await fixture()
  const path = join(input.controllerHome, '.config/harlan-checkin/site.env')
  await writeFile(path, 'CHECKIN_TOKEN=private\n', { mode: 0o600 })
  await chmod(path, 0o644)
  await expect(checkinEnvironment(input)).rejects.toThrow('private')
})

it('rejects a credential alias to another file', async () => {
  const input = await fixture()
  const secret = join(input.controllerHome, 'secret')
  await writeFile(secret, 'CHECKIN_TOKEN=other\n', { mode: 0o600 })
  await symlink(secret, join(input.controllerHome, '.config/harlan-checkin/site.env'))
  await expect(checkinEnvironment(input)).rejects.toThrow()
})
