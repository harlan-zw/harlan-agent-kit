import { execFile } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/cli.ts')

it('shows parsed configuration without credentials, network access, or state creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octorun-cli-config-'))
  const configPath = join(root, 'config.json')
  await writeFile(configPath, JSON.stringify({ version: 1, stateDir: join(root, 'state'), github: { appId: '1', privateKeyEnv: 'TEST_APP_KEY', webhookSecretEnv: 'TEST_WEBHOOK_SECRET' }, provider: { baseUrl: 'https://provider.invalid/v1', model: 'test-model', apiKeyEnv: 'TEST_MODEL_KEY' }, repositories: [{ id: 1, fullName: 'example/project', installationId: 2 }] }))
  try {
    const result = await execute(process.execPath, ['--experimental-strip-types', cliPath, '--config', configPath, '--json', 'config'], { cwd: root, env: { PATH: process.env.PATH, TEST_MODEL_KEY: 'secret-value-must-not-appear' } })
    expect(JSON.parse(result.stdout)).toMatchObject({ github: { appId: '1', privateKeyEnv: 'TEST_APP_KEY' }, provider: { model: 'test-model', apiKeyEnv: 'TEST_MODEL_KEY' }, repositories: [{ fullName: 'example/project' }] })
    expect(result.stdout).not.toContain('secret-value-must-not-appear')
    await expect(access(join(root, 'state'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
