import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export interface TerminalArtifact {
  entry: string
  digest: string
  wasm: string
  wasmDigest: string
}
export interface TerminalScope {
  loadState: string
  activeState: string
  invocationId: string
  controlGroup: string
  mainPid: number
}
export interface TerminalProcessHost {
  inspect: (unit: string) => Promise<TerminalScope>
  start: (options: {
    unit: string
    artifact: TerminalArtifact
    config: string
    reservationId: string
    memoryGiB: number
  }) => Promise<void>
  stop: (unit: string, invocationId: string) => Promise<'Stopped' | 'Unknown'>
}
export async function verifyTerminalArtifact(artifact: TerminalArtifact) {
  if (
    !isAbsolute(artifact.entry) ||
    !isAbsolute(artifact.wasm) ||
    !/^[a-f\d]{64}$/.test(artifact.digest) ||
    !/^[a-f\d]{64}$/.test(artifact.wasmDigest)
  ) {
    throw new Error('Invalid terminal artifact')
  }
  if (basename(dirname(artifact.entry)) !== artifact.digest)
    throw new Error('Terminal artifact requires a versioned directory')
  const entry = await readFile(artifact.entry)
  const wasm = await readFile(artifact.wasm)
  if (
    createHash('sha256').update(entry).digest('hex') !== artifact.digest ||
    createHash('sha256').update(wasm).digest('hex') !== artifact.wasmDigest
  ) {
    throw new Error('Terminal artifact changed')
  }
}
export function createTerminalSystemdHost(
  nodePath: string,
  path = process.env.PATH ?? '',
  run: typeof execute = execute,
): TerminalProcessHost {
  const helperPath = [
    ...new Set([dirname(nodePath), ...path.split(':').filter(isAbsolute), '/usr/local/bin', '/usr/bin', '/bin']),
  ].join(':')
  async function inspect(unit: string): Promise<TerminalScope> {
    if (!/^wolfstar-terminal-[a-f\d]{24}\.service$/.test(unit)) throw new Error('Invalid terminal unit')
    const { stdout } = await run(
      'systemctl',
      ['--user', 'show', unit, '--property=LoadState,ActiveState,InvocationID,ControlGroup,MainPID'],
      { timeout: 10000 },
    )
    const values = Object.fromEntries(
      stdout
        .trim()
        .split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    )
    return {
      loadState: values.LoadState ?? '',
      activeState: values.ActiveState ?? '',
      invocationId: values.InvocationID ?? '',
      controlGroup: values.ControlGroup ?? '',
      mainPid: Number(values.MainPID ?? 0),
    }
  }
  return {
    inspect,
    async start(options) {
      await verifyTerminalArtifact(options.artifact)
      await run(
        'systemd-run',
        [
          '--user',
          '--quiet',
          '--unit',
          options.unit,
          '--service-type=exec',
          '--property=KillMode=control-group',
          '--property=Restart=no',
          '--property=TimeoutStopSec=10s',
          `--property=MemoryMax=${options.memoryGiB}G`,
          '--property=MemorySwapMax=0',
          '--property=CollectMode=inactive-or-failed',
          `--setenv=PATH=${helperPath}`,
          `--setenv=WOLFSTAR_HOST_RESERVATION=${options.reservationId}`,
          nodePath,
          options.artifact.entry,
          options.config,
        ],
        { timeout: 10000 },
      )
    },
    async stop(unit, invocationId) {
      const before = await inspect(unit)
      if (!invocationId || before.invocationId !== invocationId) return 'Unknown'
      await run('systemctl', ['--user', 'stop', unit], { timeout: 15000 })
      const after = await inspect(unit)
      if (after.invocationId && after.invocationId !== invocationId) return 'Unknown'
      return after.activeState === 'inactive' || after.loadState === 'not-found' ? 'Stopped' : 'Unknown'
    },
  }
}
