import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

interface SyncInput {
  manifest: string
  dataRoot: string
  binary: string
  check: boolean
}

interface Invocation {
  binary: string
  args: string[]
  env: NodeJS.ProcessEnv
}

function runCli(input: Invocation): number {
  const result = spawnSync(input.binary, input.args, { env: input.env, stdio: 'inherit' })
  if (result.error)
    throw result.error
  if (result.status === null)
    throw new Error('skilld stopped without an exit code.')
  return result.status
}

/** skilld owns preparation, conflict checks, target adoption, and transaction recovery. */
export function syncSkills(input: SyncInput, run: (input: Invocation) => number = runCli): number {
  return run({
    binary: input.binary,
    args: ['sync', '--manifest', resolve(input.manifest), '--global', input.check ? '--check' : '--adopt', '--plain'],
    env: { ...process.env, SKILLD_DATA_DIR: resolve(input.dataRoot), SKILLD_NO_UPGRADE: '1', SKILLD_NO_WEEKLY: '1' },
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--check'))
    throw new Error('Use sync:skills or check:skills. The only option is --check.')
  process.exitCode = syncSkills({
    manifest: fileURLToPath(new URL('../.skills/skilld.json', import.meta.url)),
    dataRoot: join(homedir(), '.local/share/harlan-agent-kit/skilld'),
    binary: process.env.HARLAN_AGENT_SKILLD_BINARY ?? 'skilld',
    check: args.includes('--check'),
  })
}
