import type { TerminalAdmission } from './terminal-admission.ts'
import type {
  TerminalCapabilities,
  TerminalCapacity,
  TerminalLaunch,
  TerminalProject,
  TerminalProvider,
  TerminalResult,
  TerminalSession,
} from './terminal-protocol.ts'
import type { TerminalIntent } from './terminal-storage.ts'
import type { TerminalArtifact, TerminalProcessHost } from './terminal-systemd.ts'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { parseHostTerminalCapacity } from './terminal-capacity.ts'
import {
  initializeTerminalStorage,
  readTerminalIntents,
  readTerminalPrepared,
  terminalIdentity,
  writeTerminalJson,
} from './terminal-storage.ts'

export interface TerminalHelperConfig {
  protocol: 1
  directory: string
  intent: TerminalIntent
  executable: string
  argv: string[]
  project: TerminalProject
  wasm: string
  wasmDigest: string
  admissionCli: string
  claimScript: string
  protectedPaths: string[]
}
export async function createTerminalManager(options: {
  directory: string
  bootId: string
  hostLabel: string
  controller: boolean
  controllerReadOnly?: boolean
  projects: TerminalProject[]
  providers: Record<TerminalProvider, { executable: string; argv: string[]; available: boolean }>
  artifact: TerminalArtifact
  admission: TerminalAdmission
  admissionCli: string
  claimScript: string
  processHost: TerminalProcessHost
  memoryGiB: number
  recoverWorktree: (project: TerminalProject, sessionId: string) => Promise<string | null>
  releaseWorktree: (sessionId: string, path: string) => Promise<void>
  renewWorktree: (sessionId: string, path: string) => Promise<void>
  ready: (intent: TerminalIntent) => Promise<boolean>
  now: () => Date
  log: (message: string, cause: unknown) => void
  active?: () => boolean
  protectedPaths?: string[]
}) {
  const host = await initializeTerminalStorage(options.directory, options.bootId)
  const intents = new Map((await readTerminalIntents(options.directory)).map((intent) => [intent.session.id, intent]))
  const launches = new Map<string, Promise<TerminalResult<TerminalSession>>>()
  const operations = new Map<string, Promise<unknown>>()
  let queueOrder = Math.max(0, ...[...intents.values()].map((intent) => intent.queueOrder))
  let closed = false
  let closing: Promise<void> | undefined
  let queueRetry: Promise<void> | undefined
  function owned<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = operations.get(id)
    // Each caller receives its own error. Later independent work can reconcile that session.
    const next = (previous ? previous.then(task, task) : task()).finally(() => {
      if (operations.get(id) === next) operations.delete(id)
    })
    operations.set(id, next)
    return next
  }
  async function persist(intent: TerminalIntent) {
    intents.set(intent.session.id, intent)
    await writeTerminalJson(join(options.directory, 'sessions', intent.session.id, 'intent.json'), intent)
  }
  function session(intent: TerminalIntent): TerminalSession {
    return { ...intent.session }
  }
  async function reconcile(intent: TerminalIntent) {
    if (intent.decision._tag === 'Queued' || intent.decision._tag === 'Cancelled') return
    if (intent.session.state === 'Exited' || intent.session.state === 'Interrupted') {
      return
    }
    const prepared = await readTerminalPrepared(options.directory, intent)
    if (prepared) intent.session.worktree = prepared.worktree
    let reservation = await options.admission.reconcile(`terminal:${intent.session.id}`).catch((cause) => {
      options.log('Host ownership unavailable', cause)
      return { _tag: 'Unknown' } as const
    })
    if (reservation._tag === 'Missing' && intent.reservationId && intent.decision._tag === 'Accepted') {
      reservation = await options.admission
        .completedReceipt({
          requestId: intent.admission.requestId,
          fingerprint: intent.fingerprint,
          key: `terminal:${intent.session.id}`,
          reservationId: intent.reservationId,
          unit: intent.unit,
        })
        .catch((cause) => {
          options.log('Host completion proof unavailable', cause)
          return { _tag: 'Unknown' } as const
        })
    }
    if (reservation._tag === 'Empty' || reservation._tag === 'Completed') {
      const released = await options.admission.release(`terminal:${intent.session.id}`)
      if (!['Empty', 'Missing', 'Completed'].includes(released._tag)) {
        intent.session.state = 'Unknown'
        await persist(intent)
        return
      }
      if (!intent.session.worktree) {
        const project = options.projects.find((project) => project.id === intent.session.projectId)
        if (project) {
          intent.session.worktree = await options.recoverWorktree(project, intent.session.id)
        }
      }
      if (intent.session.worktree) {
        await options.releaseWorktree(intent.session.id, intent.session.worktree)
      }
      intent.session.state = intent.session.bootId === host.bootId ? 'Exited' : 'Interrupted'
      await persist(intent)
    } else if (reservation._tag === 'Alive') {
      const scope = await options.processHost.inspect(intent.unit)
      if (
        !reservation.scope ||
        scope.invocationId !== reservation.scope.invocationId ||
        scope.controlGroup !== reservation.scope.controlGroup
      ) {
        intent.session.state = 'Unknown'
      } else {
        intent.invocationId = scope.invocationId
        intent.controlGroup = scope.controlGroup
        intent.session.state =
          scope.mainPid && (await options.ready(intent))
            ? intent.session.state === 'Stopping'
              ? 'Stopping'
              : 'Running'
            : scope.mainPid && !intent.session.worktree
              ? 'Starting'
              : 'Unknown'
      }
      await persist(intent)
    } else {
      intent.session.state = 'Unknown'
      await persist(intent)
    }
  }
  async function launch(request: TerminalLaunch, manual = false): Promise<TerminalResult<TerminalSession>> {
    if (options.active && !options.active()) return { _tag: 'Err', reason: 'OwnershipUnknown' }
    const identity = terminalIdentity(host.hostId, request)
    const existing = intents.get(identity.id)
    if (existing) {
      if (existing.fingerprint !== identity.fingerprint) return { _tag: 'Err', reason: 'LaunchConflict' }
      if (existing.decision._tag === 'Queued') {
        return manual ? forceIntent(existing, `manual:${request.requestId}`) : { _tag: 'Ok', value: session(existing) }
      }
      if (existing.decision._tag === 'Cancelled') return { _tag: 'Ok', value: session(existing) }
      if (existing.decision._tag === 'Rejected') return { _tag: 'Err', reason: existing.decision.reason }
      if (existing.decision._tag === 'Pending')
        return manual && existing.admission._tag === 'ManualOverride'
          ? forceIntent(existing, existing.admission.requestId)
          : { _tag: 'Err', reason: 'OwnershipUnknown' }
      await reconcile(existing)
      return { _tag: 'Ok', value: session(existing) }
    }
    const project = options.projects.find((project) => project.id === request.projectId)
    // Every request remains replayable. Refuse further records rather than evicting uncertain ownership.
    if (intents.size >= 1000) return { _tag: 'Err', reason: 'SizeLimit' }
    if (!project) return { _tag: 'Err', reason: 'ProjectUnavailable' }
    const provider = options.providers[request.provider]
    if (!provider.available) return { _tag: 'Err', reason: 'ProviderUnavailable' }
    const intent: TerminalIntent = {
      decision: { _tag: 'Queued', reason: 'Requested' },
      admission: { _tag: 'Regular', requestId: request.requestId },
      queueOrder: ++queueOrder,
      manualAttempts: {},
      protocol: 1,
      fingerprint: identity.fingerprint,
      launch: request,
      unit: identity.unit,
      helperToken: randomUUID() + randomUUID(),
      reservationId: null,
      invocationId: null,
      controlGroup: null,
      helperDigest: options.artifact.digest,
      session: {
        id: identity.id,
        generation: randomUUID(),
        projectId: request.projectId,
        provider: request.provider,
        hostId: host.hostId,
        bootId: host.bootId,
        state: 'Queued',
        createdAt: options.now().toISOString(),
        worktree: null,
      },
    }
    await mkdir(join(options.directory, 'sessions', identity.id), {
      mode: 0o700,
      recursive: true,
    })
    await persist(intent)
    if (manual) return forceIntent(intent, `manual:${request.requestId}`)
    if (
      [...intents.values()].some(
        (other) =>
          other !== intent &&
          other.decision._tag === 'Queued' &&
          other.admission._tag === 'Regular' &&
          other.queueOrder < intent.queueOrder,
      )
    )
      return { _tag: 'Ok', value: session(intent) }
    return admit(intent)
  }
  async function admit(intent: TerminalIntent): Promise<TerminalResult<TerminalSession>> {
    if (closed || (options.active && !options.active())) return { _tag: 'Err', reason: 'OwnershipUnknown' }
    const request = intent.launch
    const identity = terminalIdentity(host.hostId, request)
    const project = options.projects.find((project) => project.id === request.projectId)
    const provider = options.providers[request.provider]
    if (!project || !provider.available) {
      intent.decision = { _tag: 'Rejected', reason: !project ? 'ProjectUnavailable' : 'ProviderUnavailable' }
      intent.session.state = 'Interrupted'
      await persist(intent)
      return { _tag: 'Err', reason: intent.decision.reason }
    }
    intent.decision = { _tag: 'Pending' }
    intent.session.state = 'Starting'
    await persist(intent)
    const admission = await options.admission
      .reserve({
        requestId: intent.admission.requestId,
        admission: intent.admission._tag,
        fingerprint: identity.fingerprint,
        key: `terminal:${identity.id}`,
        role: 'interactive',
        memoryGiB: options.memoryGiB,
        unit: identity.unit,
      })
      .catch((cause) => {
        options.log('Host admission unavailable', cause)
        return { _tag: 'Unknown' } as const
      })
    if (admission._tag !== 'Admitted') {
      if (admission._tag === 'AtCapacity') {
        if (intent.admission._tag === 'ManualOverride') {
          intent.manualAttempts[intent.admission.requestId] = { _tag: 'Refused', reason: admission.reason }
          // A refused manual attempt has no root receipt. Keep this same intent eligible for Regular retry.
          intent.admission = { _tag: 'Regular', requestId: request.requestId }
        }
        intent.decision = { _tag: 'Queued', reason: admission.reason }
        intent.session.state = 'Queued'
        await persist(intent)
        return { _tag: 'Ok', value: session(intent) }
      }
      intent.session.state = admission._tag === 'Completed' ? 'Exited' : 'Unknown'
      if (admission._tag === 'Completed' || admission._tag === 'Conflict') {
        intent.decision = {
          _tag: 'Rejected',
          reason: 'LaunchConflict',
        }
        intent.session.state = 'Interrupted'
      }
      await persist(intent)
      return {
        _tag: 'Err',
        reason: intent.admission._tag === 'ManualOverride' ? 'DeliveryUnknown' : 'CapacityUnavailable',
      }
    }
    intent.reservationId = admission.reservationId
    if (intent.admission._tag === 'ManualOverride')
      intent.manualAttempts[intent.admission.requestId] = { _tag: 'Accepted' }
    intent.decision = { _tag: 'Accepted' }
    await persist(intent)
    if (admission.disposition === 'Existing') {
      await reconcile(intent)
      return { _tag: 'Ok', value: session(intent) }
    }
    // Only a newly admitted request may create its stable helper. A retry never repeats this effect.
    const helper: TerminalHelperConfig = {
      protocol: 1,
      directory: options.directory,
      intent,
      executable: provider.executable,
      argv: [
        ...provider.argv,
        ...(request.initialPrompt === undefined
          ? []
          : request.provider === 'opencode'
            ? [`--prompt=${request.initialPrompt}`]
            : ['--', request.initialPrompt]),
      ],
      project,
      wasm: options.artifact.wasm,
      wasmDigest: options.artifact.wasmDigest,
      admissionCli: options.admissionCli,
      claimScript: options.claimScript,
      protectedPaths: [options.directory, ...(options.protectedPaths ?? [])],
    }
    const config = join(options.directory, 'sessions', identity.id, 'helper.json')
    await writeTerminalJson(config, helper)
    await options.processHost.start({
      unit: identity.unit,
      artifact: options.artifact,
      config,
      reservationId: admission.reservationId,
      memoryGiB: options.memoryGiB,
    })
    // The helper binds before spawning. The manager never authorizes a provider by probing a PID.
    for (let check = 0; check < 25; check++) {
      if (await options.ready(intent)) break
      await setTimeout(100)
    }
    await reconcile(intent)
    return { _tag: 'Ok', value: session(intent) }
  }
  async function forceIntent(intent: TerminalIntent, requestId: string): Promise<TerminalResult<TerminalSession>> {
    // An explicit retry resolves the exact root request. It never replaces an uncertain charge.
    if (intent.decision._tag === 'Pending' && intent.admission._tag === 'ManualOverride') return admit(intent)
    const previous = Object.hasOwn(intent.manualAttempts, requestId) ? intent.manualAttempts[requestId] : undefined
    if (previous)
      return previous._tag === 'Pending'
        ? { _tag: 'Err', reason: 'DeliveryUnknown' }
        : { _tag: 'Ok', value: session(intent) }
    if (intent.decision._tag !== 'Queued') return { _tag: 'Err', reason: 'LaunchConflict' }
    if (Object.keys(intent.manualAttempts).length >= 128) return { _tag: 'Err', reason: 'SizeLimit' }
    intent.manualAttempts[requestId] = { _tag: 'Pending' }
    intent.admission = { _tag: 'ManualOverride', requestId }
    // Fence cancellation and automatic retry before the potentially admitted root request starts.
    intent.decision = { _tag: 'Pending' }
    intent.session.state = 'Starting'
    await persist(intent)
    return admit(intent)
  }
  function retryQueued(): Promise<void> {
    if (queueRetry) return queueRetry
    queueRetry = (async () => {
      if (closed || (options.active && !options.active())) return
      const next = [...intents.values()]
        .filter((intent) => intent.decision._tag === 'Queued' && intent.admission._tag === 'Regular')
        .sort((a, b) => a.queueOrder - b.queueOrder || a.session.id.localeCompare(b.session.id))[0]
      if (!next) return
      const capacity = await options.admission.capacity()
      if (capacity._tag !== 'Capacity' || capacity.regular._tag !== 'Allowed') return
      await owned(next.session.id, async () => {
        if (closed || next.decision._tag !== 'Queued' || next.admission._tag !== 'Regular') return
        await admit(next)
      })
    })().finally(() => {
      queueRetry = undefined
    })
    return queueRetry
  }
  const queueTimer = setInterval(() => {
    void retryQueued().catch((cause) => options.log('Queued session retry failed', cause))
  }, 10000)
  queueTimer.unref()
  const housekeeping = setInterval(
    () => {
      void (async () => {
        await Promise.all(
          [...intents.values()].map((intent) =>
            owned(intent.session.id, async () => {
              await reconcile(intent)
              if (intent.session.worktree && !['Exited', 'Interrupted'].includes(intent.session.state)) {
                await options.renewWorktree(intent.session.id, intent.session.worktree)
              }
            }),
          ),
        )
      })().catch((cause) => options.log('Terminal ownership reconciliation failed', cause))
    },
    5 * 60 * 1000,
  )
  housekeeping.unref()
  return {
    async capacity(): Promise<TerminalCapacity> {
      const result = await options.admission.capacity().catch((cause) => {
        options.log('Host admission unavailable', cause)
        return { _tag: 'Unavailable' } as const
      })
      const parsed = parseHostTerminalCapacity(result)
      return parsed._tag === 'Ok' ? parsed.value : { _tag: 'Unavailable' }
    },
    close() {
      if (!closing) {
        closed = true
        clearInterval(housekeeping)
        clearInterval(queueTimer)
        closing = Promise.allSettled([...operations.values(), ...(queueRetry ? [queueRetry] : [])]).then(() => {})
      }
      return closing
    },
    host,
    directory: options.directory,
    retryQueued,
    forceQueued(id: string, requestId: string) {
      if (closed) return Promise.resolve({ _tag: 'Err', reason: 'OwnershipUnknown' } as const)
      return owned(id, async () => {
        const intent = intents.get(id)
        return intent
          ? forceIntent(intent, `manual:${requestId}`)
          : ({ _tag: 'Err', reason: 'SessionUnavailable' } as const)
      })
    },
    launchForce(request: TerminalLaunch) {
      if (closed) return Promise.resolve({ _tag: 'Err', reason: 'OwnershipUnknown' } as const)
      const identity = terminalIdentity(host.hostId, request)
      return owned(identity.id, () => launch(request, true))
    },
    capabilities(): TerminalCapabilities {
      return {
        protocol: 1,
        hostId: host.hostId,
        bootId: host.bootId,
        hostLabel: options.hostLabel,
        controller: options.controller,
        controllerReadOnly: options.controllerReadOnly ?? false,
        providers: {
          codex: options.providers.codex.available,
          claude: options.providers.claude.available,
          opencode: options.providers.opencode.available,
        },
        supports: {
          terminal: true,
          stop: true,
          writer: true,
          resize: true,
          mouse: true,
          focus: true,
        },
      }
    },
    projects: () => options.projects.map((project) => ({ ...project })),
    async sessions() {
      if (closed) return [...intents.values()].map(session)
      await Promise.all([...intents.values()].map((intent) => owned(intent.session.id, () => reconcile(intent))))
      return [...intents.values()].map(session)
    },
    intent(id: string) {
      return intents.get(id)
    },
    launch(request: TerminalLaunch) {
      if (closed) return Promise.resolve({ _tag: 'Err', reason: 'OwnershipUnknown' } as const)
      const identity = terminalIdentity(host.hostId, request)
      const pending = launches.get(identity.id)
      if (pending) {
        return pending.then((result) => {
          const accepted = intents.get(identity.id)
          return accepted?.fingerprint === identity.fingerprint
            ? result
            : ({ _tag: 'Err', reason: 'LaunchConflict' } as const)
        })
      }
      const promise = owned(identity.id, () => launch(request)).finally(() => launches.delete(identity.id))
      launches.set(identity.id, promise)
      return promise
    },
    async stop(id: string): Promise<TerminalResult<TerminalSession>> {
      if (closed) return { _tag: 'Err', reason: 'OwnershipUnknown' }
      return owned(id, async () => {
        const intent = intents.get(id)
        if (!intent) return { _tag: 'Err', reason: 'SessionUnavailable' }
        if (intent.decision._tag === 'Queued' || intent.decision._tag === 'Cancelled') {
          intent.decision = { _tag: 'Cancelled' }
          intent.session.state = 'Cancelled'
          await persist(intent)
          return { _tag: 'Ok', value: session(intent) }
        }
        await reconcile(intent)
        if (intent.session.state === 'Exited' || intent.session.state === 'Interrupted') {
          return { _tag: 'Ok', value: session(intent) }
        }
        if (
          intent.decision._tag === 'Pending' &&
          intent.admission._tag === 'ManualOverride' &&
          !intent.reservationId &&
          !intent.invocationId
        )
          return { _tag: 'Err', reason: 'DeliveryUnknown' }
        if (!intent.invocationId && intent.reservationId) {
          const cancelled = await options.admission.cancel({
            key: `terminal:${id}`,
            reservationId: intent.reservationId,
          })
          if (cancelled._tag === 'Empty') {
            if (intent.session.worktree) await options.releaseWorktree(id, intent.session.worktree)
            intent.session.state = 'Interrupted'
            await persist(intent)
            return { _tag: 'Ok', value: session(intent) }
          }
          if (cancelled._tag === 'Conflict') await reconcile(intent)
        }
        if (!intent.invocationId) return { _tag: 'Err', reason: 'OwnershipUnknown' }
        intent.session.state = 'Stopping'
        await persist(intent)
        await options.processHost.stop(intent.unit, intent.invocationId)
        await reconcile(intent)
        return { _tag: 'Ok', value: session(intent) }
      })
    },
  }
}
export type TerminalManager = Awaited<ReturnType<typeof createTerminalManager>>
