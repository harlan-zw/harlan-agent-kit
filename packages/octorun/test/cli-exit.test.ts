import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { startControlServer } from '../src/index.ts'

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/cli.ts')

async function executeCommand(command: 'run' | 'cancel' | 'doctor', state: string): Promise<{ code: number | null, output: unknown }> {
  const root = await mkdtemp(join(tmpdir(), 'octorun-cli-exit-'))
  const stateDir = join(root, 'state')
  const configPath = join(root, 'config.json')
  await mkdir(stateDir)
  await writeFile(configPath, JSON.stringify({
    version: 1,
    stateDir,
    github: { appId: '1', privateKeyEnv: 'TEST_APP_KEY', webhookSecretEnv: 'TEST_HOOK_KEY' },
    provider: { baseUrl: 'http://localhost:1234/v1', model: 'test-model', apiKeyEnv: 'TEST_MODEL_KEY' },
    repositories: [{ id: 1, fullName: 'example/project', installationId: 2 }],
  }))
  const controller = await startControlServer({ path: join(stateDir, 'control.sock'), handle: async () => ({ _tag: 'Ok', value: command === 'doctor' ? { ready: state === 'Succeeded' } : { runId: 'example-run', state } }) })
  try {
    const args = command === 'run' ? ['run', '--repository', 'example/project', '--pr', '7'] : command === 'cancel' ? ['cancel', 'example-run'] : ['doctor', '--online']
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', cliPath, '--config', configPath, '--json', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (!stdout)
          reject(new Error(`The CLI did not return its result: ${stderr}`))
        else
          resolve({ code, output: JSON.parse(stdout) as unknown })
      })
    })
  }
  finally {
    await controller.close()
    await rm(root, { recursive: true, force: true })
  }
}

it.each(['Failed', 'Cancelled', 'Superseded'])('returns a nonzero manual run exit code for %s without losing its result', async (state) => {
  expect(await executeCommand('run', state)).toEqual({ code: 1, output: { runId: 'example-run', state } })
})

it.each(['Succeeded', 'Waiting', 'Skipped'])('returns success for an accepted manual run in %s', async (state) => {
  expect(await executeCommand('run', state)).toEqual({ code: 0, output: { runId: 'example-run', state } })
})

it('returns success when the cancel operation succeeds', async () => {
  expect(await executeCommand('cancel', 'Cancelled')).toEqual({ code: 0, output: { runId: 'example-run', state: 'Cancelled' } })
})

it('returns a nonzero exit code when online diagnostics fail', async () => {
  expect(await executeCommand('doctor', 'Failed')).toEqual({ code: 1, output: { ready: false } })
  expect(await executeCommand('doctor', 'Succeeded')).toEqual({ code: 0, output: { ready: true } })
})
