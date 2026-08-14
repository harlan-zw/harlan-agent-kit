import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { ClaimedPublicationCommand } from './types.ts'

export interface PublicationRemote {
  finalize: (command: ClaimedPublicationCommand, signal: AbortSignal) => Promise<Result<string, string>>
  getHeadSha: (command: ClaimedPublicationCommand, signal: AbortSignal) => Promise<Result<string | null, string>>
  push: (command: ClaimedPublicationCommand, signal: AbortSignal) => Promise<Result<void, string>>
  validateAuthority: (command: ClaimedPublicationCommand, signal: AbortSignal) => Promise<Result<void, string>>
}

export interface PublicationScheduler {
  runNow: () => Promise<void>
  start: () => void
  stop: () => Promise<void>
}

export interface PublicationSchedulerOptions {
  intervalMilliseconds: number
  leaseMilliseconds: number
  now: () => Date
  onError: (error: unknown) => void
  store: Pick<JournalStore, | 'authorizePublication'
  | 'claimNextPublication'
  | 'completePublication'
  | 'deferPublication'
  | 'failPublication'
  | 'heartbeatPublication'
  | 'supersedePublication'>
  publisher: PublicationRemote
  workerId: string
}

export function createPublicationScheduler(options: PublicationSchedulerOptions): PublicationScheduler {
  let stopped = true
  let timer: NodeJS.Timeout | undefined
  let controller: AbortController | undefined
  let active: Promise<void> = Promise.resolve()

  const fail = (command: ClaimedPublicationCommand, reason: string): void => {
    options.store.failPublication({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: options.now().toISOString(),
      reason,
    })
  }

  const complete = (command: ClaimedPublicationCommand, evidence: string): void => {
    options.store.completePublication({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: options.now().toISOString(),
      evidence,
    })
  }

  async function execute(): Promise<void> {
    const command = options.store.claimNextPublication(options.workerId, options.now().toISOString(), options.leaseMilliseconds)
    if (command === null)
      return

    controller = new AbortController()
    const heartbeat = setInterval(() => {
      const renewed = options.store.heartbeatPublication({
        commandId: command.id,
        workerId: command.workerId,
        fence: command.fence,
        at: options.now().toISOString(),
        leaseMilliseconds: options.leaseMilliseconds,
      })
      if (!renewed)
        controller?.abort()
    }, Math.max(1_000, Math.floor(options.leaseMilliseconds / 3)))
    heartbeat.unref()

    try {
      const head = await options.publisher.getHeadSha(command, controller.signal)
      if (head._tag === 'Err') {
        if (command.outcomeUnknown) {
          options.store.deferPublication({
            commandId: command.id,
            workerId: command.workerId,
            fence: command.fence,
            at: options.now().toISOString(),
            reason: `Remote outcome remains unknown: ${head.error}`,
          })
        }
        else {
          fail(command, head.error)
        }
        return
      }
      if (head.value === command.commitSha) {
        const finalized = await options.publisher.finalize(command, controller.signal)
        if (finalized._tag === 'Ok')
          complete(command, finalized.value)
        else
          fail(command, finalized.error)
        return
      }
      const expectedRemoteHead = command._tag === 'OpenPullRequest' ? null : command.expectedHeadSha
      if (head.value !== expectedRemoteHead) {
        options.store.supersedePublication({
          commandId: command.id,
          workerId: command.workerId,
          fence: command.fence,
          at: options.now().toISOString(),
          reason: 'The remote branch changed before publication.',
        })
        return
      }
      const authority = await options.publisher.validateAuthority(command, controller.signal)
      if (authority._tag === 'Err') {
        options.store.supersedePublication({
          commandId: command.id,
          workerId: command.workerId,
          fence: command.fence,
          at: options.now().toISOString(),
          reason: authority.error,
        })
        return
      }
      if (!options.store.authorizePublication({
        commandId: command.id,
        workerId: command.workerId,
        fence: command.fence,
        at: options.now().toISOString(),
      })) {
        return
      }

      const pushed = await options.publisher.push(command, controller.signal)
      if (pushed._tag === 'Err') {
        const reconciledHead = await options.publisher.getHeadSha(command, controller.signal)
        if (reconciledHead._tag === 'Err') {
          options.store.deferPublication({
            commandId: command.id,
            workerId: command.workerId,
            fence: command.fence,
            at: options.now().toISOString(),
            reason: `Push outcome is unknown: ${pushed.error} Remote check failed: ${reconciledHead.error}`,
          })
        }
        else if (reconciledHead.value === command.commitSha) {
          const finalized = await options.publisher.finalize(command, controller.signal)
          if (finalized._tag === 'Ok')
            complete(command, finalized.value)
          else
            fail(command, finalized.error)
        }
        else if (reconciledHead.value === expectedRemoteHead) {
          fail(command, pushed.error)
        }
        else {
          options.store.supersedePublication({
            commandId: command.id,
            workerId: command.workerId,
            fence: command.fence,
            at: options.now().toISOString(),
            reason: 'The remote branch changed while publication ran.',
          })
        }
        return
      }
      const publishedHead = await options.publisher.getHeadSha(command, controller.signal)
      if (publishedHead._tag === 'Err') {
        options.store.deferPublication({
          commandId: command.id,
          workerId: command.workerId,
          fence: command.fence,
          at: options.now().toISOString(),
          reason: `Push completed but remote confirmation failed: ${publishedHead.error}`,
        })
        return
      }
      if (publishedHead.value !== command.commitSha) {
        options.store.supersedePublication({
          commandId: command.id,
          workerId: command.workerId,
          fence: command.fence,
          at: options.now().toISOString(),
          reason: 'The remote branch changed after publication.',
        })
        return
      }
      const finalized = await options.publisher.finalize(command, controller.signal)
      if (finalized._tag === 'Ok')
        complete(command, finalized.value)
      else
        fail(command, finalized.error)
    }
    finally {
      clearInterval(heartbeat)
    }
  }

  function runNow(): Promise<void> {
    active = active.then(execute).catch(options.onError)
    return active
  }

  function schedule(): void {
    if (stopped)
      return
    timer = setTimeout(() => void runNow().finally(schedule), options.intervalMilliseconds)
    timer.unref()
  }

  function start(): void {
    if (!stopped)
      return
    stopped = false
    void runNow().finally(schedule)
  }

  async function stop(): Promise<void> {
    stopped = true
    if (timer !== undefined)
      clearTimeout(timer)
    controller?.abort()
    await active
  }

  return { runNow, start, stop }
}
