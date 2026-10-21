import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/cli.ts')

it.each(['corrupt', 'newer-schema'])('reports safe recovery steps for a %s restore failure', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'octorun-cli-restore-'))
  const configPath = join(root, 'config.json')
  const source = join(root, 'backup.sqlite')
  await writeFile(configPath, JSON.stringify({
    version: 1,
    stateDir: join(root, 'state'),
    github: { appId: '1', privateKeyEnv: 'TEST_APP_KEY', webhookSecretEnv: 'TEST_HOOK_KEY' },
    provider: { baseUrl: 'http://localhost:1234/v1', model: 'test-model', apiKeyEnv: 'TEST_MODEL_KEY' },
    repositories: [{ id: 1, fullName: 'example/project', installationId: 2 }],
  }))
  if (kind === 'corrupt') {
    await writeFile(source, 'PRIVATE-CREDENTIAL-SENTINEL')
  }
  else {
    const database = new DatabaseSync(source)
    database.exec('PRAGMA user_version=999')
    database.close()
  }
  try {
    const result = await new Promise<{ code: number | null, stdout: string, stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', cliPath, '--config', configPath, '--json', 'restore', source], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.once('error', reject)
      child.once('close', code => resolve({ code, stdout, stderr }))
    })
    expect(result.code).toBe(1)
    const line = result.stderr.split('\n').find(line => line.startsWith('{'))
    const diagnostic: unknown = line ? JSON.parse(line) : null
    expect(diagnostic).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration', message: expect.stringMatching(/backup integrity|schema compatibility/) } })
    expect(result.stderr).toMatch(/Check|Choose/)
    expect(result.stderr).not.toContain('PRIVATE-CREDENTIAL-SENTINEL')
    expect(result.stdout).toBe('')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
