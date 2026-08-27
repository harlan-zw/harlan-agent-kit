import type { ConsolaInstance } from 'consola'
import type { Server } from 'srvx'
import type { AgentProviderName } from './agent-provider.ts'
import type { GitIdentity } from './git-identity.ts'
import type { GitHubUserAccess } from './github-user-access.ts'
import type { Result } from './result.ts'
import type { RoutineSyncOutcome } from './routine-controller.ts'
import type { JournalStore } from './store.ts'
import type { ClaimedAgentTask, DashboardSnapshot, RepositoryMapping, ServiceTrigger, ValidatedAgentConfig } from './types.ts'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createAgentActivityLog } from './agent-activity.ts'
import { agentLabelItem } from './agent-label.ts'
import { createAgentPermitPool } from './agent-permit-pool.ts'
import { AGENT_PROVIDER_NAMES, agentProfile, createAgentRuntimeSource } from './agent-profile.ts'
import { DEFAULT_CACHED_CONTEXT_BUDGET } from './agent-provider.ts'
import { createAgentApp } from './app.ts'
import { createApprovalController } from './approval-controller.ts'
import { createAutoMergeController } from './auto-merge-controller.ts'
import { createBaselineRepairWorker } from './baseline-repair-worker.ts'
import { createCandidateIssueController } from './candidate-issue-controller.ts'
import { resolveAgentStartState } from './capacity.ts'
import { createCodexProvider } from './codex-provider.ts'
import { validateRepositoryMappings } from './config.ts'
import { createConflictWorker } from './conflict-worker.ts'
import { createExternalWatchController, mergeExternalWatchSnapshot } from './external-watch.ts'
import { classifyFailure } from './failure.ts'
import { createGitHubAgentSource } from './github-agent-source.ts'
import { createGitHubAppTokenProvider, createRoutedTokenProvider, createUserTokenProvider } from './github-auth.ts'
import { createGitHubUserAccess } from './github-user-access.ts'
import { createGitHubWriteGate, preflightGitHubWriteAccess, repositoryQuarantineReason, withGitHubWritePreflight } from './github-write-gate.ts'
import { createGitHubIssuePublisher, createGitHubPullRequestMerger, createGitHubPullRequestPublisher, createGitHubSource } from './github.ts'
import { createIssueTriageCommentController } from './issue-triage-comment-controller.ts'
import { createIssueWorkWorker } from './issue-work-worker.ts'
import { createIssueTriageWorker, createReviewWorker } from './item-agent.ts'
import { createOpencodeProvider } from './opencode-provider.ts'
import { createPoller } from './poller.ts'
import { chooseAgentProvider, createProviderCapacitySource } from './provider-capacity.ts'
import { createPublicationScheduler } from './publication-scheduler.ts'
import { createPullRequestStatusController } from './pull-request-status-controller.ts'
import { createPullRequestTriageAgent } from './pull-request-triage.ts'
import { publishQueuePositions } from './queue-position-sweep.ts'
import { reconcileAllRepositories } from './reconcile.ts'
import { buildRepositoryMappings, discoverGitHubAppRepositories, discoverLocalCheckouts, discoverUserRepositories, installedWithoutCheckout } from './repository-discovery.ts'
import { err, ok } from './result.ts'
import { publishResolvedCiReviews } from './review-ci-sweep.ts'
import { AGENT_ACTOR_LOGIN } from './review-comment.ts'
import { createReviewFixWorker } from './review-fix-worker.ts'
import { syncOpenReviewRerunRequests } from './review-rerun-controller.ts'
import { createReviewStatusController } from './review-status-controller.ts'
import { publishStoppedReviews } from './review-stop-sweep.ts'
import { planRoutineRuns, syncRepositoryRoutines } from './routine-controller.ts'
import { createRoutineReportController } from './routine-report-controller.ts'
import { createRoutineScanWorker } from './routine-worker.ts'
import { clearAbandonedRunningLabels } from './running-label-sweep.ts'
import { startAgentServer } from './server.ts'
import { openJournalStore } from './store.ts'
import { createTaskScheduler } from './task-scheduler.ts'
import { createTerminalSessionLauncher } from './terminal-session.ts'
import { createReconcileHint, createWebhookApp } from './webhook.ts'
import { createWorkerTaskScheduler } from './worker-task-scheduler.ts'
import { agentWorktreeLeaseKey, createAgentWorkspaceManager, createBaselineRepairWorktreeManager, createConflictWorktreeManager, createGitPublicationRemote, createIssueWorktreeManager, createReviewFixWorktreeManager, sweepAgentWorktrees } from './worktree.ts'

export interface RunningAgentService {
  server: Server
  stop: () => Promise<void>
}

export interface StartAgentServiceOptions {
  config: ValidatedAgentConfig
  /** Required when the configuration enables the webhook listener. */
  webhookSecret?: string
  userAccess?: GitHubUserAccess
  dashboardPassword: string
  githubPrivateKey: string
  gitIdentity: GitIdentity
  logger: Pick<ConsolaInstance, 'error' | 'info'>
  now?: () => Date
}

/** Records the repository observation that replaces GitHub polling on a Routine-only host. */
export function recordRoutineOnlyRepositoryHealth(input: {
  at: string
  outcome: RoutineSyncOutcome
  repository: string
  store: Pick<JournalStore, 'recordPollFailure' | 'recordPollSuccess'>
}): void {
  if (input.outcome._tag === 'Unread') {
    input.store.recordPollFailure(
      input.repository,
      input.at,
      `The Routine spec could not be read. ${input.outcome.reason}`,
    )
    return
  }
  input.store.recordPollSuccess(input.repository, input.at)
}

/** Omits Routine history when this service does not answer the Routine trigger. */
export function dashboardSnapshotForTriggers(
  snapshot: DashboardSnapshot,
  triggers: readonly ServiceTrigger[],
): DashboardSnapshot {
  return triggers.includes('routine')
    ? snapshot
    : { ...snapshot, routines: [], routineRuns: [] }
}

function recordServiceIncident(
  store: Pick<JournalStore, 'recordIncident'>,
  at: string,
  operation: string,
  message: string,
): void {
  const failure = classifyFailure({ message })
  store.recordIncident({
    scope: { _tag: 'Service' },
    kind: failure.kind,
    severity: failure._tag === 'Transient' ? 'warning' : 'error',
    operation,
    message,
    recovery: failure._tag === 'Transient'
      ? { _tag: 'Retrying', attempt: 0, nextAttemptAt: at }
      : { _tag: 'ActionRequired' },
    at,
  })
}

/**
 * Records one poll pass's failures, unless the pass was aborted.
 *
 * Stopping the service aborts every request still in flight, and each one
 * rejects with an abort. Those rejects are the shutdown, not a fault. Recording
 * them filled the System pane with dozens of Incidents on every restart and
 * buried the real ones, so an aborted pass reports nothing and the next pass
 * records the truth.
 */
export function createPassIncidentRecorder(options: {
  now: () => Date
  signal: AbortSignal
  store: Pick<JournalStore, 'recordIncident' | 'resolveIncidents'>
}): (operation: string, messages: readonly string[]) => void {
  return (operation, messages) => {
    if (options.signal.aborted)
      return
    replaceServiceIncidents(options.store, options.now().toISOString(), operation, messages)
  }
}

/** Replaces one controller pass's Service Incidents with its current failures. */
export function replaceServiceIncidents(
  store: Pick<JournalStore, 'recordIncident' | 'resolveIncidents'>,
  at: string,
  operation: string,
  messages: readonly string[],
): void {
  const currentMessages = [...new Set(messages)]
  currentMessages.forEach(message => recordServiceIncident(store, at, operation, message))
  store.resolveIncidents({ _tag: 'Service' }, at, operation, currentMessages)
}

/**
 * Reads Harlan's GitHub login, retrying a failure that describes the API and
 * not the account.
 *
 * A degraded GitHub answers one read and rejects the next, so a single reject
 * is never enough to conclude the CLI is unusable.
 */
export async function resolveUserLogin(
  userAccess: Pick<GitHubUserAccess, 'login'>,
  logger: Pick<ConsolaInstance, 'info'>,
  attempts = 3,
  delayMilliseconds = 2_000,
): Promise<Result<string, string>> {
  let lastError = 'The GitHub CLI returned no account.'
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const login = await userAccess.login().then(ok).catch((error: unknown) => err(error instanceof Error ? error.message : 'The GitHub CLI failed.'))
    if (login._tag === 'Ok' && login.value.trim().length > 0)
      return ok(login.value.trim())
    lastError = login._tag === 'Err' ? login.error : lastError
    if (attempt < attempts) {
      logger.info(`The GitHub CLI could not name its account (attempt ${attempt} of ${attempts}). Retrying.`)
      // Never unref this timer. Nothing else is scheduled during start, so an
      // unreferenced wait empties the event loop and the process exits cleanly
      // in the middle of starting up.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMilliseconds * attempt)
      })
    }
  }
  return err(lastError)
}

export async function startAgentService(options: StartAgentServiceOptions): Promise<RunningAgentService> {
  const now = options.now ?? (() => new Date())
  const [installedRepositories, localCheckouts] = await Promise.all([
    discoverGitHubAppRepositories({
      appId: options.config.github.appId,
      allowedOwners: options.config.github.allowedOwners,
      privateKey: options.githubPrivateKey,
    }),
    discoverLocalCheckouts(options.config.trustedCheckoutRoots),
  ])
  const userAccess = options.userAccess ?? createGitHubUserAccess()
  const userRepositories = await discoverUserRepositories({
    allowedOwners: options.config.github.allowedOwners,
    checkouts: localCheckouts,
    installed: installedRepositories,
    readRepository: github => userAccess.readRepository(github),
  })
  // The GitHub CLI answers a degraded API with an error, and reading Harlan's
  // login used to throw out of start and take the whole service with it. The
  // repositories that need the login are dropped for this run instead, so the
  // ones that do not need it keep working.
  const resolvedLogin = userRepositories.length === 0
    ? { _tag: 'Ok' as const, value: AGENT_ACTOR_LOGIN }
    : await resolveUserLogin(userAccess, options.logger)
  const activeUserRepositories = resolvedLogin._tag === 'Ok' ? userRepositories : []
  const userLogin = resolvedLogin._tag === 'Ok' ? resolvedLogin.value : AGENT_ACTOR_LOGIN
  if (resolvedLogin._tag === 'Err') {
    options.logger.error(`The GitHub CLI could not name its account, so ${userRepositories.length} repositories that need it stay untracked this run: ${resolvedLogin.error}`)
  }
  if (activeUserRepositories.length > 0)
    options.logger.info(`${activeUserRepositories.length} repositories answer to @${userLogin} because the GitHub App is not installed: ${activeUserRepositories.map(repository => repository.github).join(', ')}.`)
  const userRepositoryNames = new Set(activeUserRepositories.map(repository => repository.github.toLowerCase()))
  const discoveredMappings = buildRepositoryMappings([...installedRepositories, ...activeUserRepositories], localCheckouts, options.config.repositories, options.config.github.allowedOwners)
  const validatedDiscovery = await validateRepositoryMappings({ ...options.config, repositories: discoveredMappings })
  if (validatedDiscovery._tag === 'Err')
    throw new Error(validatedDiscovery.error.map(issue => `${issue.path}: ${issue.message}`).join(' '))
  const config = validatedDiscovery.value
  options.logger.info(`GitHub App grants ${installedRepositories.length} repositories. Found ${config.repositories.length} trusted checkouts.`)
  const unmapped = installedWithoutCheckout(installedRepositories, localCheckouts, options.config.github.allowedOwners)
  if (unmapped.length > 0) {
    // Naming a long tail of legacy repositories every start is noise, so name only a short list.
    const names = unmapped.length <= 12 ? `: ${unmapped.join(', ')}` : ''
    options.logger.info(`${unmapped.length} granted repositories have no local checkout under a trusted root, so no agent can see them${names}. Clone one to include it.`)
  }

  const configuredProfile = agentProfile(config.agent.provider)
  const store = openJournalStore(config.storage.path, config.mutationsEnabled, configuredProfile, config.maxOpenPullRequests)
  // Capacity is normal System state now. Clear the legacy Incident once, so a
  // service upgraded while every provider was at its Reserve does not keep it.
  store.resolveIncidents({ _tag: 'Service' }, now().toISOString(), 'agent_capacity')
  // A weekly window moves over hours, so a reading minutes old still decides
  // correctly. Refreshing on its own interval keeps a subprocess out of the
  // path of every agent turn.
  const capacity = createProviderCapacitySource({
    onError: error => options.logger.error(error),
  })
  const chooseProvider = (order: readonly AgentProviderName[]): AgentProviderName | null => chooseAgentProvider({
    capacity: capacity.read,
    order,
    reservePercent: config.agent.reservePercent,
  })
  // Both provider runtimes are built once. Switching the Agent selection then
  // costs one journal read, and the service never restarts to answer it.
  const runtime = createAgentRuntimeSource({
    chooseProvider,
    configuredProvider: configuredProfile.provider,
    maximumActiveAgents: configuredProfile.maximumActiveAgents,
    providers: { codex: createCodexProvider(), opencode: createOpencodeProvider({ cachedContextBudget: DEFAULT_CACHED_CONTEXT_BUDGET }) },
    selection: store.getAgentSelection,
  })
  const profile = runtime().profile
  options.logger.info(`Agent provider: ${profile.provider} with ${profile.roles.adversarial_review.model}.`)
  const startedAt = now().toISOString()
  store.syncRepositories(config.repositories, startedAt)
  if (config.mutationsEnabled) {
    const recovered = store.recoverInterruptedAgentTasks(startedAt)
    if (recovered > 0)
      options.logger.info(`Recovered ${recovered} interrupted agent tasks.`)
    // Repositories GitHub is answering again get back the recovery budget an
    // outage spent, before the first pass decides what to requeue.
    const stale = store.resolveStaleTaskIncidents(startedAt)
    if (stale > 0)
      options.logger.info(`Closed ${stale} incidents whose task can no longer run.`)
    const freed = store.restoreOutageRecoveryBudget(startedAt)
    if (freed > 0)
      options.logger.info(`Restored the recovery budget of ${freed} tasks that a GitHub outage exhausted.`)
    const retried = store.retryRecoverableWorkerFailures(startedAt)
    if (retried > 0)
      options.logger.info(`Retried ${retried} tasks after recoverable controller failures were repaired.`)
  }
  // A repository the App cannot reach is answered with Harlan's own account.
  const actorLogin = (repository: RepositoryMapping): string => repository.authentication === 'user' ? userLogin : AGENT_ACTOR_LOGIN
  const routedTokens = createRoutedTokenProvider({
    app: createGitHubAppTokenProvider({
      appId: config.github.appId,
      privateKey: options.githubPrivateKey,
    }),
    user: createUserTokenProvider({ readToken: signal => userAccess.token(signal) }),
    usesUserToken: repository => userRepositoryNames.has(repository.toLowerCase()),
  })
  // Write authority belongs at the credential boundary. Every current and
  // future mutation needs one of these write credentials before it can leave.
  const tokens = createGitHubWriteGate({
    mayWrite: github => store.mayWriteRepository(github),
    onRefused: (github) => {
      store.recordIncident({
        scope: { _tag: 'Repository', repository: github },
        kind: 'policy',
        severity: 'warning',
        message: repositoryQuarantineReason(github),
        operation: 'write',
        recovery: { _tag: 'ActionRequired' },
        at: now().toISOString(),
      })
    },
    source: routedTokens,
  })
  const github = createGitHubSource({ actorLogin, tokens, issueCutoff: config.issueCutoff })
  const pullRequestStatuses = createPullRequestStatusController({
    github,
    now,
    repositories: config.repositories,
  })
  const installed = new Set(config.repositories.map(repository => repository.github.toLowerCase()))
  const externalWatches = config.externalRepositories.filter(watch => !installed.has(watch.github.toLowerCase()))
  const externalWatch = createExternalWatchController({
    watches: externalWatches,
    issueCutoff: config.issueCutoff,
    now,
  })
  // Ephemeral: what each running agent is doing right now, never persisted.
  const activityLog = createAgentActivityLog()
  const workerGithub = createGitHubAgentSource({ actorLogin, tokens })
  const mutationSchedulers = await (async () => {
    if (!config.mutationsEnabled)
      return undefined
    const controllerRoot = join(dirname(config.storage.path), 'worktrees')
    const worktrees = createConflictWorktreeManager({
      gitIdentity: options.gitIdentity,
      root: controllerRoot,
      tokens,
    })
    const workspaces = createAgentWorkspaceManager({ root: controllerRoot, tokens })
    const fixWorktrees = createReviewFixWorktreeManager({ gitIdentity: options.gitIdentity, root: controllerRoot, tokens })
    const baselineWorktrees = createBaselineRepairWorktreeManager({ gitIdentity: options.gitIdentity, root: controllerRoot, tokens })
    const issueWorktrees = createIssueWorktreeManager({ gitIdentity: options.gitIdentity, root: controllerRoot, tokens })
    const permits = createAgentPermitPool(profile.maximumActiveAgents)
    /**
     * Whether a scheduler may start another agent Task right now.
     *
     * Pause is a person's decision. Capacity is the account's. Automatic
     * selection stops here when no Agent provider may spend its window, so the
     * service waits for the reset instead of starting work it cannot pay for.
     * Active agents and controller Publications finish either way.
     */
    const canClaim = (): boolean => {
      if (store.getAgentControl()._tag !== 'Running')
        return false
      const selection = store.getAgentSelection()
      if (selection._tag !== 'Automatic')
        return true
      return chooseProvider(selection.order) !== null
    }
    /**
     * Writes the Running label as the scheduler takes and gives up a lease.
     *
     * A person deciding what to open next reads a list of issues and pull
     * requests, not a list of comments, and an issue carries no progress
     * comment at all while triage or issue work runs. The write never blocks
     * the agent: a label that failed to land is worth an Incident, not a Task.
     *
     * The clear takes off the Running label alone. A settled Review stamps its
     * verdict just before its Task settles, and a blanket clear would wipe it.
     *
     * Each write carries its own deadline, so a slow GitHub cannot hold the
     * shutdown open on a label nobody is waiting for.
     */
    const labelDeadline = (): AbortSignal => AbortSignal.timeout(30_000)
    const labelWrite = (label: string, write: Promise<Result<void, string>>): void => {
      void write
        .then((result) => {
          if (result._tag === 'Err')
            options.logger.error(`${label}: ${result.error}`)
        })
        .catch((error: unknown) => options.logger.error(error))
    }
    const stampRunningLabel = (task: object): void => {
      const item = agentLabelItem(task)
      if (item === undefined)
        return
      labelWrite('Running label', workerGithub.stampAgentLabel(item.repositoryMapping, item.itemNumber, 'RUNNING', labelDeadline()))
    }
    const settleTask = (taskId: string, task: object): void => {
      activityLog.clear(taskId)
      const item = agentLabelItem(task)
      if (item === undefined)
        return
      labelWrite('Running label', workerGithub.clearRunningLabel(item.repositoryMapping, item.itemNumber, labelDeadline()))
    }
    const validateMapping = async (mapping: RepositoryMapping) => {
      const validated = await validateRepositoryMappings({ ...config, repositories: [mapping] })
      if (validated._tag === 'Err')
        return err(validated.error.map(issue => `${issue.path}: ${issue.message}`).join(' '))
      const current = validated.value.repositories[0]
      return current === undefined ? err('Repository mapping disappeared during validation.') : ok(current)
    }
    const conflictWorker = withGitHubWritePreflight({
      accesses: ['item_write', 'contents_write'],
      source: tokens,
      worker: createConflictWorker({
        activityLog,
        github,
        now,
        runtime,
        store,
        worktrees,
        validateMapping,
      }),
    })
    const reviewStatus = createReviewStatusController({
      github: workerGithub,
      leaseMilliseconds: 2 * 60_000,
      now,
      store,
      workerId: randomUUID(),
    })
    const subjectWorkerOptions = {
      activityLog,
      github: workerGithub,
      now,
      onProgressPublishFailure: (task: ClaimedAgentTask, reason: string) => {
        options.logger.error(`${task.repository}: status update failed, the review continues: ${reason}`)
        const failure = classifyFailure({ message: reason })
        store.recordIncident({
          scope: { _tag: 'Task', taskId: task.id, repository: task.repository, itemNumber: null },
          kind: failure.kind,
          severity: 'warning',
          operation: 'review_status_comment',
          message: reason,
          recovery: { _tag: 'Retrying', attempt: 0, nextAttemptAt: now().toISOString() },
          at: now().toISOString(),
        })
      },
      onProgressPublishSuccess: (task: ClaimedAgentTask) => {
        store.resolveIncidents(
          { _tag: 'Task', taskId: task.id, repository: task.repository, itemNumber: null },
          now().toISOString(),
          'review_status_comment',
        )
      },
      preflightRepair: (repository: string, signal: AbortSignal) => preflightGitHubWriteAccess(tokens, repository, ['contents_write'], signal),
      pullRequestTriage: createPullRequestTriageAgent({ activityLog, now, runtime, store, workspace: controllerRoot }),
      store,
      runtime,
      status: reviewStatus,
      triageStatus: createIssueTriageCommentController({
        github: workerGithub,
        leaseMilliseconds: 2 * 60_000,
        now,
        store,
        workerId: randomUUID(),
      }),
      workspaces,
    }
    return {
      approvals: createApprovalController({
        github: workerGithub,
        now,
        store,
      }),
      autoMerge: createAutoMergeController({
        merger: createGitHubPullRequestMerger({ tokens }),
        policy: config.autoMerge,
        report: (event) => {
          if (event._tag === 'AutoMergeEnabled') {
            options.logger.info(`${event.repository}#${event.pullRequestNumber}: GitHub auto-merge is enabled. GitHub merges it when its checks pass.`)
            return
          }
          if (event._tag === 'Merged') {
            options.logger.info(`${event.repository}#${event.pullRequestNumber}: merged ${event.sha.slice(0, 12)}, because GitHub had nothing left to wait for.`)
            return
          }
          options.logger.error(`${event.repository}#${event.pullRequestNumber}: GitHub refused auto-merge: ${event.reason}`)
          recordServiceIncident(store, now().toISOString(), 'auto_merge', event.reason)
        },
        store,
      }),
      baselineRepairs: createTaskScheduler({
        canClaim,
        claim: store.claimNextBaselineRepairTask,
        intervalMilliseconds: 5_000,
        leaseMilliseconds: 45 * 60_000,
        now,
        onError: error => options.logger.error(error),
        onTaskStarted: stampRunningLabel,
        onTaskSettled: settleTask,
        permits,
        store,
        worker: withGitHubWritePreflight({
          accesses: ['item_write', 'contents_write'],
          source: tokens,
          worker: createBaselineRepairWorker({
            activityLog,
            github: workerGithub,
            now,
            runtime,
            store,
            validateMapping,
            worktrees: baselineWorktrees,
          }),
        }),
        workerId: randomUUID(),
      }),
      routines: createWorkerTaskScheduler({
        canClaim,
        claim: store.claimNextRoutineRun,
        complete: store.completeRoutineRun,
        fail: store.failRoutineRun,
        heartbeat: store.heartbeatRoutineRun,
        intervalMilliseconds: 5_000,
        // A scan reads a whole repository, so it gets the same room as a review.
        leaseMilliseconds: 45 * 60_000,
        now,
        onError: error => options.logger.error(error),
        onTaskStarted: stampRunningLabel,
        onTaskSettled: settleTask,
        permits,
        // A scan is read only, so it needs no write access to start.
        worker: createRoutineScanWorker({
          logger: {
            error: message => options.logger.error(message),
            info: message => options.logger.info(message),
          },
          now,
          runtime,
          store,
          workspaces,
        }),
        workerId: randomUUID(),
      }),
      issues: createWorkerTaskScheduler({
        canClaim,
        claim: store.claimNextIssueTriageTask,
        complete: store.completeWorkerTask,
        fail: store.failWorkerTask,
        heartbeat: store.heartbeatWorkerTask,
        intervalMilliseconds: 5_000,
        leaseMilliseconds: 20 * 60_000,
        now,
        onError: error => options.logger.error(error),
        onTaskStarted: stampRunningLabel,
        onTaskSettled: settleTask,
        permits,
        worker: withGitHubWritePreflight({
          accesses: ['item_write'],
          source: tokens,
          worker: createIssueTriageWorker(subjectWorkerOptions),
        }),
        workerId: randomUUID(),
      }),
      publications: createPublicationScheduler({
        intervalMilliseconds: 2_000,
        leaseMilliseconds: 2 * 60_000,
        now,
        onError: error => options.logger.error(error),
        store,
        publisher: createGitPublicationRemote({
          github,
          pullRequests: createGitHubPullRequestPublisher({ tokens }),
          root: controllerRoot,
          tokens,
        }),
        workerId: randomUUID(),
      }),
      repairs: Array.from({ length: profile.maximumActiveAgents }, () => createTaskScheduler({
        canClaim,
        claim: store.claimNextReviewFixTask,
        intervalMilliseconds: 5_000,
        leaseMilliseconds: 45 * 60_000,
        now,
        onError: error => options.logger.error(error),
        onTaskStarted: stampRunningLabel,
        onTaskSettled: settleTask,
        permits,
        store,
        worker: withGitHubWritePreflight({
          accesses: ['item_write', 'contents_write'],
          source: tokens,
          worker: createReviewFixWorker({
            activityLog,
            github: workerGithub,
            now,
            onProgressPublishFailure: subjectWorkerOptions.onProgressPublishFailure,
            runtime,
            status: reviewStatus,
            store,
            validateMapping,
            worktrees: fixWorktrees,
          }),
        }),
        workerId: randomUUID(),
      })),
      reviews: Array.from({ length: profile.maximumActiveAgents }, () => createWorkerTaskScheduler({
        canClaim,
        claim: store.claimNextAdversarialReviewTask,
        complete: store.completeWorkerTask,
        fail: store.failWorkerTask,
        heartbeat: store.heartbeatWorkerTask,
        intervalMilliseconds: 5_000,
        leaseMilliseconds: 45 * 60_000,
        now,
        onError: error => options.logger.error(error),
        onTaskStarted: stampRunningLabel,
        onTaskSettled: settleTask,
        permits,
        worker: withGitHubWritePreflight({
          accesses: ['item_write'],
          source: tokens,
          worker: createReviewWorker(subjectWorkerOptions),
        }),
        workerId: randomUUID(),
      })),
      issueWork: createTaskScheduler({
        // New work waits while the open pull requests already need Harlan.
        // Manual Selection mode makes Harlan the throttle, so the count stops
        // counting: every pull request the agent opens was already selected.
        canClaim: () => canClaim()
          && (store.getSelectionMode() === 'manual' || store.countOpenPullRequests() < config.maxOpenPullRequests),
        claim: store.claimNextIssueWorkTask,
        intervalMilliseconds: 5_000,
        leaseMilliseconds: 45 * 60_000,
        now,
        onError: error => options.logger.error(error),
        onTaskStarted: stampRunningLabel,
        onTaskSettled: settleTask,
        permits,
        store,
        worker: withGitHubWritePreflight({
          accesses: ['item_write', 'contents_write'],
          source: tokens,
          worker: createIssueWorkWorker({
            github: workerGithub,
            activityLog,
            now,
            runtime,
            store,
            validateMapping,
            worktrees: issueWorktrees,
          }),
        }),
        workerId: randomUUID(),
      }),
      tasks: createTaskScheduler({
        canClaim,
        intervalMilliseconds: 5_000,
        leaseMilliseconds: 10 * 60_000,
        now,
        onError: error => options.logger.error(error),
        onTaskStarted: stampRunningLabel,
        onTaskSettled: settleTask,
        permits,
        store,
        worker: conflictWorker,
        workerId: randomUUID(),
      }),
    }
  })().catch((error) => {
    store.close()
    throw error
  })
  const candidateIssues = createCandidateIssueController({
    github: createGitHubIssuePublisher({ tokens: routedTokens }),
    now,
    store,
    workerId: randomUUID(),
  })
  const routineReports = createRoutineReportController({
    github: createGitHubIssuePublisher({ tokens: routedTokens }),
    now,
    store,
    workerId: randomUUID(),
  })
  const poller = createPoller({
    intervalMilliseconds: config.pollIntervalSeconds * 1_000,
    timeoutMilliseconds: Math.max(5 * 60_000, config.pollIntervalSeconds * 4_000),
    poll: async (signal) => {
      const recordPassIncidents = createPassIncidentRecorder({ store, now, signal })
      const results = !config.triggers.includes('github')
        ? []
        : await reconcileAllRepositories(config.repositories, {
            ...(mutationSchedulers === undefined
              ? {}
              : { approvals: mutationSchedulers.approvals, autoMerge: mutationSchedulers.autoMerge }),
            github,
            store,
            now,
            signal,
          })
      if (signal.aborted)
        return
      results.forEach((result) => {
        if (result._tag === 'Ok')
          options.logger.info(`${result.value.repository}: observed ${result.value.subjects} open pull requests and issues.`)
        else
          options.logger.error(`${result.error.repository}: ${result.error.message}`)
      })
      // A Failed Task recovers on every pass, not only at start. Waiting for a
      // restart is what kept a transient GitHub reject holding a review down
      // for a whole day.
      if (config.mutationsEnabled) {
        store.resolveStaleTaskIncidents(now().toISOString())
        const retried = store.retryRecoverableWorkerFailures(now().toISOString())
        if (retried > 0)
          options.logger.info(`Requeued ${retried} tasks after recoverable failures.`)
      }
      // Routines answer a clock, so they are read and planned on the same pass
      // that observes GitHub. A repository declares its own schedule, and the
      // spec is read at the default branch commit only.
      const routineFailures: string[] = []
      const syncedRoutines = !config.triggers.includes('routine')
        ? []
        : await Promise.all(config.repositories
            .filter(repository => repository.enabled)
            .map(async repository => ({
              repository: repository.github,
              outcome: await syncRepositoryRoutines(repository, { github, store, now, signal }),
            })))
      if (signal.aborted)
        return
      syncedRoutines.forEach(({ repository, outcome }) => {
        if (outcome._tag === 'Refused')
          routineFailures.push(`${repository}: the Routine spec was refused. ${outcome.reason}`)
        if (outcome._tag === 'Unread')
          routineFailures.push(`${repository}: the Routine spec could not be read. ${outcome.reason}`)
        if (outcome._tag === 'Synced' && outcome.routines.length > 0)
          options.logger.info(`${repository}: ${outcome.routines.length} routines declared.`)
      })
      if (!config.triggers.includes('github')) {
        const observedAt = now().toISOString()
        syncedRoutines.forEach(({ repository, outcome }) => recordRoutineOnlyRepositoryHealth({
          at: observedAt,
          outcome,
          repository,
          store,
        }))
      }
      recordPassIncidents('routine_spec', routineFailures)

      // Candidate issues are filed on the same pass, a few at a time. A scan
      // that found twenty proposals must not open twenty issues at once.
      if (config.mutationsEnabled && config.triggers.includes('routine')) {
        const filed = await candidateIssues.publishPending(signal)
        filed.forEach((result) => {
          if (result._tag === 'Ok')
            options.logger.info(`${result.value.repository}#${result.value.issueNumber}: filed a routine proposal.`)
        })
        recordPassIncidents('candidate_issue', filed.flatMap(result => result._tag === 'Err' ? [result.error] : []))

        const reported = await routineReports.publishPending(signal)
        recordPassIncidents('routine_report', reported.flatMap(result => result._tag === 'Err' ? [result.error] : []))
      }

      if (config.mutationsEnabled && config.triggers.includes('routine')) {
        const planned = planRoutineRuns({ now, store })
        planned.opened.forEach(run => options.logger.info(`${run.repository}: queued the ${run.name} routine for ${run.scheduledFor}.`))
        planned.skipped.forEach(run => options.logger.info(`${run.repository}: skipped the ${run.name} routine due at ${run.scheduledFor}.`))
      }

      // Everything below answers a GitHub observation, so a routines-only
      // machine skips it and never reads or writes another machine's work.
      if (!config.triggers.includes('github'))
        return
      const reruns = await syncOpenReviewRerunRequests(config.repositories, {
        allowedAuthors: config.github.allowedOwners,
        github,
        store,
        now,
        signal,
      })
      reruns.forEach((result) => {
        if (result._tag === 'Err') {
          options.logger.error(`Review rerun command: ${result.error}`)
        }
        else if (result.value.results.some(item => item._tag === 'Queued')) {
          options.logger.info(`${result.value.repository}: queued a requested review rerun.`)
        }
      })
      recordPassIncidents('review_rerun', reruns.flatMap(result => result._tag === 'Err' ? [result.error] : []))
      const statusSync = await pullRequestStatuses.sync(store.getDashboardSnapshot(now().toISOString()), signal)
      statusSync.errors.forEach((error) => {
        options.logger.error(`Pull request status: ${error}`)
      })
      recordPassIncidents('pull_request_status', statusSync.errors)
      if (mutationSchedulers !== undefined) {
        const stopped = await publishStoppedReviews({
          github: workerGithub,
          now,
          repositories: config.repositories,
          store,
        }, signal)
        // The list size, every pass. A sweep that reports three outcomes while
        // its list holds a hundred rows is invisible without this line.
        if (stopped.results.length > 0 || stopped.remaining > 0) {
          options.logger.info(stopped.remaining > 0
            ? `Stopped review comments: closed ${stopped.results.length} this pass, ${stopped.remaining} left for the next.`
            : `Stopped review comments: closed ${stopped.results.length}.`)
        }
        stopped.results.forEach((result) => {
          if (result._tag === 'Ok') {
            options.logger.info(result.value._tag === 'CommentGone'
              ? `${result.value.repository}#${result.value.pullRequestNumber}: the stopped review comment was deleted, so nothing was written.`
              : result.value._tag === 'Superseded'
                ? `${result.value.repository}#${result.value.pullRequestNumber}: another writer took the comment, so it was left alone.`
                : `${result.value.repository}#${result.value.pullRequestNumber}: closed the stopped review comment.`)
          }
          else {
            options.logger.error(`Stopped review comment: ${result.error}`)
          }
        })
        recordPassIncidents('stopped_review_comment', stopped.results.flatMap(result => result._tag === 'Err' ? [result.error] : []))
        const settled = await publishResolvedCiReviews({
          github: workerGithub,
          now,
          repositories: config.repositories,
          store,
        }, signal)
        settled.forEach((result) => {
          if (result._tag === 'Ok') {
            if (result.value._tag === 'Republished')
              options.logger.info(`${result.value.repository}#${result.value.pullRequestNumber}: CI settled, so the review now reads ${result.value.outcome}.`)
            else if (result.value._tag === 'CommentGone')
              options.logger.info(`${result.value.repository}#${result.value.pullRequestNumber}: the review comment was deleted, so nothing was written.`)
            else if (result.value._tag === 'Superseded')
              options.logger.info(`${result.value.repository}#${result.value.pullRequestNumber}: the head commit moved, so the waiting review was left alone.`)
          }
          else {
            options.logger.error(`Waiting review: ${result.error}`)
          }
        })
        recordPassIncidents('waiting_review_ci', settled.flatMap(result => result._tag === 'Err' ? [result.error] : []))
        const positions = await publishQueuePositions({
          github: workerGithub,
          now,
          repositories: config.repositories,
          store,
        }, signal)
        positions.forEach((result) => {
          if (result._tag === 'Ok') {
            options.logger.info(result.value._tag === 'CommentGone'
              ? `${result.value.repository}#${result.value.pullRequestNumber}: the automated comment was deleted, so nothing was written.`
              : result.value._tag === 'Superseded'
                ? `${result.value.repository}#${result.value.pullRequestNumber}: an agent claimed the Task, so the Queue position comment was left to it.`
                : result.value.queue._tag === 'Paused'
                  ? `${result.value.repository}#${result.value.pullRequestNumber}: the comment now reads that the repository is paused.`
                  : `${result.value.repository}#${result.value.pullRequestNumber}: the comment now reads Queue position ${result.value.queue.position} of ${result.value.queue.total}.`)
          }
          else {
            options.logger.error(`Queue position comment: ${result.error}`)
          }
        })
        recordPassIncidents('queue_position_comment', positions.flatMap(result => result._tag === 'Err' ? [result.error] : []))
      }
      // Only a pass where nothing succeeded describes an outage. Throwing for a
      // partial failure backed the poller off to its 15 minute ceiling and held
      // every healthy repository there, because one repository always failed.
      const failed = results.filter(result => result._tag === 'Err').length
      if (failed > 0 && failed === results.length)
        throw new Error(`Every repository reconciliation failed (${failed}).`)
      if (failed > 0)
        options.logger.info(`${failed} of ${results.length} repositories failed this pass. The rest reconciled.`)
    },
    onError: error => options.logger.error(error),
  })
  const externalPoller = createPoller({
    intervalMilliseconds: 5 * 60_000,
    poll: async (signal) => {
      const results = await externalWatch.poll(signal)
      results.forEach((result) => {
        if (result.error === undefined)
          options.logger.info(`${result.repository}: observed ${result.subjects} exact public issues.`)
        else
          options.logger.error(`${result.repository}: ${result.error}`)
      })
      if (results.some(result => result.error !== undefined))
        throw new Error('One or more external repository watches failed.')
    },
    onError: error => options.logger.error(error),
  })
  // Every claim of a Task takes a new fence, and each fence owns its own
  // worktree. Nothing removed the worktree a fenced out claim left behind, so
  // one retried Task could hold a dozen checkouts on disk for good.
  const worktreeSweeper = createPoller({
    intervalMilliseconds: 5 * 60_000,
    poll: async (signal) => {
      const recordSweepIncidents = createPassIncidentRecorder({ store, now, signal })
      const checkouts = [...new Set(config.repositories.map(repository => repository.checkout))]
      const failures: string[] = []
      for (const checkout of checkouts) {
        const swept = await sweepAgentWorktrees({
          checkout,
          readLiveLeaseKeys: () => new Set(store.listActiveTaskLeases().map(agentWorktreeLeaseKey)),
        }, signal)
        if (swept._tag === 'Err') {
          options.logger.error(`Agent worktree sweep in ${checkout}: ${swept.error}`)
          failures.push(swept.error)
          continue
        }
        if (swept.value.removed.length > 0)
          options.logger.info(`${checkout}: removed ${swept.value.removed.length} agent worktrees that no task uses.`)
        swept.value.failures.forEach((failure) => {
          const message = `Could not remove agent worktree ${failure.branch}: ${failure.reason}`
          options.logger.error(message)
          failures.push(message)
        })
      }
      recordSweepIncidents('agent_worktree_sweep', failures)
    },
    onError: error => options.logger.error(error),
  })
  const dashboardShutdown = new AbortController()
  const app = createAgentApp({
    activityLog,
    ejectAgent: createTerminalSessionLauncher({ onError: error => options.logger.error(error) }),
    store: {
      approveIssueWork: store.approveIssueWork,
      approvePullRequest: store.approvePullRequest,
      cancelTask: store.cancelTask,
      getDashboardSnapshot: (at) => {
        const snapshot = dashboardSnapshotForTriggers(
          pullRequestStatuses.apply(mergeExternalWatchSnapshot(store.getDashboardSnapshot(at), externalWatch.snapshot())),
          config.triggers,
        )
        const providerCapacities = AGENT_PROVIDER_NAMES.map(provider => ({
          provider,
          capacity: capacity.read(provider),
          reservePercent: config.agent.reservePercent[provider],
        }))
        const current = {
          ...snapshot,
          agentProviderOrder: config.agent.order,
          providerCapacities,
        }
        return { ...current, agentStart: resolveAgentStartState(current) }
      },
      listReviewRuns: store.listReviewRuns,
      pauseAgents: store.pauseAgents,
      requestReviewRerun: store.requestReviewRerun,
      resumeAgents: store.resumeAgents,
      selectAgent: store.selectAgent,
      setRepositoryPaused: store.setRepositoryPaused,
      setRepositoryWritesEnabled: store.setRepositoryWritesEnabled,
      setSelectionMode: store.setSelectionMode,
      dismissItem: store.dismissItem,
      restoreItem: store.restoreItem,
    },
    allowedOrigin: config.server.allowedOrigin,
    dashboardPassword: options.dashboardPassword,
    now,
    shutdownSignal: dashboardShutdown.signal,
  })
  const server = await startAgentServer({
    app,
    hostname: config.server.host,
    port: config.server.port,
  }).catch((error) => {
    store.close()
    throw error
  })
  capacity.start()
  // A delivery says "read GitHub again", never what changed. Reconciliation
  // stays the only writer, so a missed, duplicated, or forged delivery can at
  // worst ask for a pass the poller would have run anyway.
  const reconcileHint = createReconcileHint({
    onError: error => options.logger.error(error),
    run: () => poller.runNow(),
  })
  const webhookServer = config.webhook._tag === 'Disabled' || options.webhookSecret === undefined
    ? null
    : await startAgentServer({
        app: createWebhookApp({
          allowedOwners: config.github.allowedOwners,
          logger: { info: message => options.logger.info(message) },
          onHint: () => reconcileHint.hint(),
          secret: options.webhookSecret,
        }),
        hostname: config.webhook.host,
        port: config.webhook.port,
      }).catch((error: unknown) => {
      // A busy port must not take the whole service down. Polling still works.
        options.logger.error(`The webhook listener did not start: ${error instanceof Error ? error.message : 'unknown error'}`)
        return null
      })

  // A process that died mid-Task left the Running label saying an Agent is on
  // an Item nothing is on. The journal answers that, so it is settled once here
  // before any scheduler can claim work and write the label again.
  if (config.mutationsEnabled && config.triggers.includes('github')) {
    void clearAbandonedRunningLabels({
      github: workerGithub,
      repositories: config.repositories,
      store,
    }, AbortSignal.timeout(5 * 60_000))
      .then((results) => {
        results.forEach((result) => {
          if (result._tag === 'Err')
            options.logger.error(`Running label: ${result.error}`)
          else if (result.value.cleared.length > 0)
            options.logger.info(`${result.value.repository}: took the Running label off ${result.value.cleared.length} items no agent is working on.`)
        })
        replaceServiceIncidents(store, now().toISOString(), 'running_label', results.flatMap(result => result._tag === 'Err' ? [result.error] : []))
      })
      .catch((error: unknown) => options.logger.error(error))
  }

  // A machine answers only the triggers its configuration names. Starting a
  // scheduler it does not own is what would let two machines claim one Task.
  const answers = (trigger: 'github' | 'routine'): boolean => config.triggers.includes(trigger)
  if (answers('github') || answers('routine'))
    poller.start()
  if (answers('github'))
    externalPoller.start()
  worktreeSweeper.start()
  if (answers('github'))
    mutationSchedulers?.tasks.start()
  if (answers('github'))
    mutationSchedulers?.baselineRepairs.start()
  if (answers('github'))
    mutationSchedulers?.issueWork.start()
  if (answers('github'))
    mutationSchedulers?.publications.start()
  if (answers('github'))
    mutationSchedulers?.repairs.forEach(scheduler => scheduler.start())
  if (answers('github'))
    mutationSchedulers?.reviews.forEach(scheduler => scheduler.start())
  if (answers('github'))
    mutationSchedulers?.issues.start()
  if (answers('routine'))
    mutationSchedulers?.routines.start()

  return {
    server,
    stop: async () => {
      await Promise.all([
        capacity.stop(),
        reconcileHint.stop(),
        poller.stop(),
        externalPoller.stop(),
        worktreeSweeper.stop(),
        mutationSchedulers?.tasks.stop() ?? Promise.resolve(),
        mutationSchedulers?.baselineRepairs.stop() ?? Promise.resolve(),
        mutationSchedulers?.issueWork.stop() ?? Promise.resolve(),
        mutationSchedulers?.publications.stop() ?? Promise.resolve(),
        ...(mutationSchedulers?.repairs.map(scheduler => scheduler.stop()) ?? []),
        ...(mutationSchedulers?.reviews.map(scheduler => scheduler.stop()) ?? []),
        mutationSchedulers?.issues.stop() ?? Promise.resolve(),
        mutationSchedulers?.routines.stop() ?? Promise.resolve(),
      ])
      dashboardShutdown.abort()
      await Promise.all([server.close(), webhookServer?.close() ?? Promise.resolve()])
      store.close()
    },
  }
}
