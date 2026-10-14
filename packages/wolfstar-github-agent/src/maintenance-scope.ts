import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentEvent, AgentProvider, AgentProviderName, AgentTurnRequest } from './agent-provider.ts'
import type { ReviewProofAuthority, ReviewProofAuthorityFactory } from './review-proof-authority.ts'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parseDesktopEvents } from './desktop-protocol.ts'
import { parseReviewProofReceipt, parseReviewProofReservation } from './review-proof-controller.ts'
import { parseReviewProofCallback } from './review-proof-duplex.ts'

export interface MaintenanceScopeOptions {
  capacityCommand: string
  memoryGiB: number
  environment?: NodeJS.ProcessEnv
  /** Injected process boundaries support isolated tests and alternate installations. */
  status?: () => Promise<unknown>
  spawn?: (command: string, args: string[], environment: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams
  executable?: string
  wait?: (signal: AbortSignal) => Promise<void>
}
export interface MaintenanceCheckInput {
  workspace: string
  command: string
  args: string[]
  signal: AbortSignal
  readOnlyPaths?: readonly string[]
  writablePaths?: readonly string[]
}
export type MaintenanceExecution =
  | { _tag: 'Turn'; name: AgentProviderName; request: Omit<AgentTurnRequest, 'signal'> }
  | { _tag: 'Check'; input: Omit<MaintenanceCheckInput, 'signal'> }

/** Old authorities cannot admit Tasks beside interactive Agents safely. */
export function parseMaintenanceAuthority(input: unknown): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('_tag' in input) ||
    input._tag !== 'Status' ||
    !('hostId' in input) ||
    typeof input.hostId !== 'string' ||
    input.hostId.length === 0 ||
    !('bootId' in input) ||
    typeof input.bootId !== 'string' ||
    input.bootId.length === 0 ||
    !('policy' in input) ||
    typeof input.policy !== 'object' ||
    input.policy === null ||
    !('agentSlots' in input.policy) ||
    !Number.isSafeInteger(input.policy.agentSlots) ||
    !('maintenanceReserve' in input.policy) ||
    !Number.isSafeInteger(input.policy.maintenanceReserve)
  ) {
    throw new Error('The shared host capacity authority is unavailable or outdated.')
  }
}

async function proofAnswer(
  authority: ReviewProofAuthority | undefined,
  action: 'reserve' | 'finish',
  input: unknown,
): Promise<unknown> {
  if (authority === undefined) throw new Error('This Task has no Review proof authority.')
  if (action === 'reserve') return authority.reserve(parseReviewProofReservation(input))
  if (
    typeof input !== 'object' ||
    input === null ||
    !('reservationId' in input) ||
    typeof input.reservationId !== 'string' ||
    !('receipt' in input)
  )
    throw new Error('The Review proof receipt is invalid.')
  await authority.finish({ reservationId: input.reservationId, receipt: parseReviewProofReceipt(input.receipt) })
  return { _tag: 'Recorded' }
}

type AdmissionPhase = { _tag: 'Awaiting' } | { _tag: 'Started' } | { _tag: 'AtCapacity' }
async function* executeAttempt(
  options: MaintenanceScopeOptions,
  key: string,
  input: MaintenanceExecution,
  signal: AbortSignal,
  authority?: ReviewProofAuthority,
): AsyncGenerator<unknown, { _tag: 'Completed' } | { _tag: 'AtCapacity' }> {
  if (signal.aborted) throw new Error('The maintenance Task was cancelled.')
  const environment = options.environment ?? process.env
  const state = await (options.status?.() ??
    promisify(execFile)(options.capacityCommand, ['status'], { env: environment }).then(
      (result) => JSON.parse(result.stdout) as unknown,
    ))
  parseMaintenanceAuthority(state)
  if (signal.aborted) throw new Error('The maintenance Task was cancelled.')
  const directory = await mkdtemp(join(tmpdir(), 'wolfstar-maintenance-'))
  let child: ChildProcessWithoutNullStreams | undefined
  let closed = false
  const stop = () => {
    if (!closed) child?.kill('SIGTERM')
  }
  try {
    const path = join(directory, 'request.json')
    await writeFile(path, JSON.stringify(input), { mode: 0o600 })
    const extension = fileURLToPath(import.meta.url).endsWith('.ts') ? 'ts' : 'mjs'
    const executable =
      options.executable ?? join(dirname(fileURLToPath(import.meta.url)), `maintenance-execute.${extension}`)
    const args = [
      'run',
      `maintenance:${createHash('sha256').update(key).digest('hex')}`,
      String(options.memoryGiB),
      process.execPath,
      '--experimental-strip-types',
      executable,
      path,
    ]
    child =
      options.spawn?.(options.capacityCommand, args, environment) ??
      spawn(options.capacityCommand, args, { env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
    const worker = child
    let stderr = ''
    worker.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-8000)
    })
    worker.stdin.on('error', (error) => {
      console.error('The maintenance proof channel failed.', error)
      stop()
    })
    const completion = new Promise<number>((resolve, reject) => {
      worker.once('error', (error) => {
        closed = true
        reject(error)
      })
      worker.once('close', (code) => {
        closed = true
        resolve(code ?? 1)
      })
    })
    // Attach rejection immediately. Awaiting below still propagates the error.
    void completion.catch((error) => {
      console.error('The maintenance worker failed to start.', error)
    })
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    let admission: AdmissionPhase = { _tag: 'Awaiting' }
    for await (const line of createInterface({ input: worker.stdout })) {
      if (Buffer.byteLength(line) > 2_000_000) throw new Error('The maintenance worker event exceeds its size limit.')
      const value: unknown = JSON.parse(line)
      if (typeof value === 'object' && value !== null && '_tag' in value && value._tag === 'AtCapacity') {
        if (
          admission._tag !== 'Awaiting' ||
          !('reason' in value) ||
          !['Memory', 'MemoryPressure', 'Slots', 'MaintenanceReserve'].includes(String(value.reason)) ||
          !('memoryGiB' in value) ||
          typeof value.memoryGiB !== 'number' ||
          !Number.isFinite(value.memoryGiB) ||
          value.memoryGiB < 0 ||
          value.memoryGiB > 65536 ||
          !('reservedGiB' in value) ||
          typeof value.reservedGiB !== 'number' ||
          !Number.isFinite(value.reservedGiB) ||
          value.reservedGiB < 0 ||
          value.reservedGiB > 65536
        ) {
          throw new Error('The maintenance admission response is invalid.')
        }
        admission = { _tag: 'AtCapacity' }
        continue
      }
      if (admission._tag === 'AtCapacity') throw new Error('The maintenance worker sent a mixed admission response.')
      admission = { _tag: 'Started' }
      const callback = parseReviewProofCallback(value)
      if (callback !== null) {
        const answer = await proofAnswer(authority, callback.action, callback.input)
          .then((result) => ({ id: callback.id, result }))
          .catch((error: unknown) => ({
            id: callback.id,
            error: error instanceof Error ? error.message.slice(0, 500) : 'The Review proof callback failed.',
          }))
        worker.stdin.write(`${JSON.stringify(answer)}\n`)
      } else {
        yield value
      }
    }
    const code = await completion
    if (code === 75 && admission._tag === 'AtCapacity') return { _tag: 'AtCapacity' }
    if (admission._tag === 'AtCapacity') throw new Error('The maintenance admission exit code is invalid.')
    if (code !== 0) throw new Error(`The admitted maintenance worker exited with code ${code}. ${stderr.trim()}`)
    return { _tag: 'Completed' }
  } finally {
    signal.removeEventListener('abort', stop)
    stop()
    await rm(directory, { recursive: true, force: true })
  }
}

async function* execute(
  options: MaintenanceScopeOptions,
  key: string,
  input: MaintenanceExecution,
  signal: AbortSignal,
  authority?: ReviewProofAuthority,
): AsyncGenerator<unknown> {
  while (true) {
    const result = yield* executeAttempt(options, key, input, signal, authority)
    if (result._tag === 'Completed') return
    // The broker refused before provider execution. Its next admission remains authoritative.
    await (options.wait?.(signal) ?? delay(5000, undefined, { signal }))
  }
}

/** One admission covers the provider, its servers, and all repository commands. */
export function createMaintenanceScopeProvider(
  options: MaintenanceScopeOptions & { name: AgentProviderName; reviewProofAuthority?: ReviewProofAuthorityFactory },
): AgentProvider {
  return {
    name: options.name,
    async *runTurn(request) {
      const { signal, ...serialized } = request
      const policy = request.toolPolicy
      const authority =
        policy?._tag === 'Review' && request.taskId !== undefined
          ? options.reviewProofAuthority?.({
              taskId: request.taskId,
              headSha: policy.headSha,
              workerId: policy.workerId,
              fence: policy.fence,
            })
          : undefined
      try {
        for await (const value of execute(
          options,
          request.taskId ?? request.workspace,
          { _tag: 'Turn', name: options.name, request: serialized },
          signal,
          authority,
        ))
          yield* parseDesktopEvents([value])
      } catch (error) {
        yield {
          _tag: 'Failed',
          reason: error instanceof Error ? error.message : String(error),
          cause: signal.aborted ? 'host-cancelled' : 'resource-limit',
        } satisfies AgentEvent
      }
    },
  }
}

/** Recovery checks and package installation use the same admission as Agents. */
export function createMaintenanceCheckCommand(
  options: MaintenanceScopeOptions,
): (input: MaintenanceCheckInput) => Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return async (input) => {
    const { signal, ...serialized } = input
    let result: { exitCode: number; stdout: string; stderr: string } | undefined
    for await (const value of execute(
      options,
      `check:${input.workspace}`,
      { _tag: 'Check', input: serialized },
      signal,
    )) {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('_tag' in value) ||
        value._tag !== 'CheckResult' ||
        !('exitCode' in value) ||
        !Number.isSafeInteger(value.exitCode) ||
        !('stdout' in value) ||
        typeof value.stdout !== 'string' ||
        !('stderr' in value) ||
        typeof value.stderr !== 'string' ||
        result !== undefined
      ) {
        throw new Error('The maintenance check result is invalid.')
      }
      result = { exitCode: Number(value.exitCode), stdout: value.stdout, stderr: value.stderr }
    }
    if (result === undefined) throw new Error('The maintenance check returned no result.')
    return result
  }
}
