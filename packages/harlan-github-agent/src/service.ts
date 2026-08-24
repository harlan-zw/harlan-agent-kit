import type { ConsolaInstance } from 'consola'
import type { Server } from 'srvx'
import type { GitIdentity } from './git-identity.ts'
import type { GitHubUserAccess } from './github-user-access.ts'
import type { Result } from './result.ts'
import type { ClaimedAgentTask, RepositoryMapping, ValidatedAgentConfig } from './types.ts'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createAgentActivityLog } from './agent-activity.ts'
import { createAgentPermitPool } from './agent-permit-pool.ts'
import { agentProfile, createAgentRuntimeSource } from './agent-profile.ts'
import { DEFAULT_CACHED_CONTEXT_BUDGET } from './agent-provider.ts'
import { createAgentApp } from './app.ts'
import { createApprovalController } from './approval-controller.ts'
import { createAutoMergeController } from './auto-merge-controller.ts'
import { createBaselineRepairWorker } from './baseline-repair-worker.ts'
import { createCodexProvider } from './codex-provider.ts'
import { validateRepositoryMappings } from './config.ts'
import { createConflictWorker } from './conflict-worker.ts'
import { createExternalWatchController, mergeExternalWatchSnapshot } from './external-watch.ts'
import { classifyFailure } from './failure.ts'
import { createGitHubAgentSource } from './github-agent-source.ts'
import { createGitHubAppTokenProvider, createRoutedTokenProvider, createUserTokenProvider } from './github-auth.ts'
import { createGitHubUserAccess } from './github-user-access.ts'
import { createGitHubWriteGate, repositoryQuarantineReason } from './github-write-gate.ts'
import { createGitHubPullRequestMerger, createGitHubPullRequestPublisher, createGitHubSource } from './github.ts'
import { createIssueTriageCommentController } from './issue-triage-comment-controller.ts'
import { createIssueWorkWorker } from './issue-work-worker.ts'
import { createIssueTriageWorker, createReviewWorker } from './item-agent.ts'
import { createOpencodeProvider } from './opencode-provider.ts'
import { createPoller } from './poller.ts'
import { createPublicationScheduler } from './publication-scheduler.ts'
import { createPullRequestStatusController } from './pull-request-status-controller.ts'
import { reconcileAllRepositories } from './reconcile.ts'
import { buildRepositoryMappings, discoverGitHubAppRepositories, discoverLocalCheckouts, discoverUserRepositories, installedWithoutCheckout } from './repository-discovery.ts'
import { err, ok } from './result.ts'
import { AGENT_ACTOR_LOGIN } from './review-comment.ts'
import { createReviewFixWorker } from './review-fix-worker.ts'
import { syncReviewRerunRequests } from './review-rerun-controller.ts'
import { createReviewStatusController } from './review-status-controller.ts'
import { publishStoppedReviews } from './review-stop-sweep.ts'
import { startAgentServer } from './server.ts'
import { openJournalStore } from './store.ts'
import { createTaskScheduler } from './task-scheduler.ts'
import { createTerminalSessionLauncher } from './terminal-session.ts'
import { createWorkerTaskScheduler } from './worker-task-scheduler.ts'
import { agentWorktreeLeaseKey, createAgentWorkspaceManager, createBaselineRepairWorktreeManager, createConflictWorktreeManager, createGitPublicationRemote, createIssueWorktreeManager, createReviewFixWorktreeManager, sweepAgentWorktrees } from './worktree.ts'

export interface RunningAgentService {
  server: Server
  stop: () => Promise<void>
}

export interface StartAgentServiceOptions {
  config: ValidatedAgentConfig
  userAccess?: GitHubUserAccess
  dashboardPassword: string
  githubPrivateKey: string
  gitIdentity: GitIdentity
  logger: Pick<ConsolaInstance, 'error' | 'info'>
  now?: () => Date
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
  // Both provider runtimes are built once. Switching the Agent selection then
  // costs one journal read, and the service never restarts to answer it.
  const runtime = createAgentRuntimeSource({
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
  const tokens = createRoutedTokenProvider({
    app: createGitHubAppTokenProvider({
      appId: config.github.appId,
      privateKey: options.githubPrivateKey,
    }),
    user: createUserTokenProvider({ readToken: signal => userAccess.token(signal) }),
    usesUserToken: repository => userRepositoryNames.has(repository.toLowerCase()),
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
  // Every GitHub write leaves through this object, so quarantine sits on it
  // rather than on the callers. Two of them write without staging a command.
  const workerGithub = createGitHubWriteGate({
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
    source: createGitHubAgentSource({ actorLogin, tokens }),
  })
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
    const canClaim = () => store.getAgentControl()._tag === 'Running'
    const validateMapping = async (mapping: RepositoryMapping) => {
      const validated = await validateRepositoryMappings({ ...config, repositories: [mapping] })
      if (validated._tag === 'Err')
        return err(validated.error.map(issue => `${issue.path}: ${issue.message}`).join(' '))
      const current = validated.value.repositories[0]
      return current === undefined ? err('Repository mapping disappeared during validation.') : ok(current)
    }
    const conflictWorker = createConflictWorker({
      activityLog,
      github,
      now,
      runtime,
      store,
      worktrees,
      validateMapping,
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
          recordServiceIncident('auto_merge', event.reason)
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
        onTaskSettled: activityLog.clear,
        permits,
        store,
        worker: createBaselineRepairWorker({
          activityLog,
          github: workerGithub,
          now,
          runtime,
          store,
          validateMapping,
          worktrees: baselineWorktrees,
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
        onTaskSettled: activityLog.clear,
        permits,
        worker: createIssueTriageWorker(subjectWorkerOptions),
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
        onTaskSettled: activityLog.clear,
        permits,
        store,
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
        onTaskSettled: activityLog.clear,
        permits,
        worker: createReviewWorker(subjectWorkerOptions),
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
        onTaskSettled: activityLog.clear,
        permits,
        store,
        worker: createIssueWorkWorker({
          github: workerGithub,
          activityLog,
          now,
          runtime,
          store,
          validateMapping,
          worktrees: issueWorktrees,
        }),
        workerId: randomUUID(),
      }),
      tasks: createTaskScheduler({
        canClaim,
        intervalMilliseconds: 5_000,
        leaseMilliseconds: 10 * 60_000,
        now,
        onError: error => options.logger.error(error),
        onTaskSettled: activityLog.clear,
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
  function recordServiceIncident(operation: string, message: string): void {
    const failure = classifyFailure({ message })
    store.recordIncident({
      scope: { _tag: 'Service' },
      kind: failure.kind,
      severity: failure._tag === 'Transient' ? 'warning' : 'error',
      operation,
      message,
      recovery: failure._tag === 'Transient'
        ? { _tag: 'Retrying', attempt: 0, nextAttemptAt: now().toISOString() }
        : { _tag: 'ActionRequired' },
      at: now().toISOString(),
    })
  }

  const poller = createPoller({
    intervalMilliseconds: config.pollIntervalSeconds * 1_000,
    timeoutMilliseconds: Math.max(5 * 60_000, config.pollIntervalSeconds * 4_000),
    poll: async (signal) => {
      const results = await reconcileAllRepositories(config.repositories, {
        ...(mutationSchedulers === undefined
          ? {}
          : { approvals: mutationSchedulers.approvals, autoMerge: mutationSchedulers.autoMerge }),
        github,
        store,
        now,
        signal,
      })
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
      const reruns = await Promise.all(config.repositories
        .filter(repository => repository.enabled && repository.pullRequestReview)
        .map(repository => syncReviewRerunRequests(repository, {
          allowedAuthors: config.github.allowedOwners,
          github,
          store,
          now,
          signal,
        })))
      reruns.forEach((result) => {
        if (result._tag === 'Err') {
          options.logger.error(`Review rerun command: ${result.error}`)
          recordServiceIncident('review_rerun', result.error)
        }
        else if (result.value.results.some(item => item._tag === 'Queued')) {
          options.logger.info(`${result.value.repository}: queued a requested review rerun.`)
        }
      })
      const statusSync = await pullRequestStatuses.sync(store.getDashboardSnapshot(now().toISOString()), signal)
      statusSync.errors.forEach((error) => {
        options.logger.error(`Pull request status: ${error}`)
        recordServiceIncident('pull_request_status', error)
      })
      if (mutationSchedulers !== undefined) {
        const stopped = await publishStoppedReviews({
          github: workerGithub,
          now,
          repositories: config.repositories,
          store,
        }, signal)
        stopped.forEach((result) => {
          if (result._tag === 'Ok') {
            options.logger.info(`${result.value.repository}#${result.value.pullRequestNumber}: closed the stopped review comment.`)
          }
          else {
            options.logger.error(`Stopped review comment: ${result.error}`)
            recordServiceIncident('stopped_review_comment', result.error)
          }
        })
      }
      // Only a pass where nothing succeeded describes an outage. Throwing for a
      // partial failure backed the poller off to its 15 minute ceiling and held
      // every healthy repository there, because one repository always failed.
      const failed = results.filter(result => result._tag === 'Err').length
      if (failed > 0 && failed === results.length)
        throw new Error(`Every repository reconciliation failed (${failed}).`)
      if (failed > 0) {
        options.logger.info(`${failed} of ${results.length} repositories failed this pass. The rest reconciled.`)
        return
      }
      store.resolveIncidents({ _tag: 'Service' }, now().toISOString())
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
      const checkouts = [...new Set(config.repositories.map(repository => repository.checkout))]
      for (const checkout of checkouts) {
        const swept = await sweepAgentWorktrees({
          checkout,
          readLiveLeaseKeys: () => new Set(store.listActiveTaskLeases().map(agentWorktreeLeaseKey)),
        }, signal)
        if (swept._tag === 'Err') {
          options.logger.error(`Agent worktree sweep in ${checkout}: ${swept.error}`)
          recordServiceIncident('agent_worktree_sweep', swept.error)
          continue
        }
        if (swept.value.removed.length > 0)
          options.logger.info(`${checkout}: removed ${swept.value.removed.length} agent worktrees that no task uses.`)
        swept.value.failures.forEach((failure) => {
          options.logger.error(`Could not remove agent worktree ${failure.branch}: ${failure.reason}`)
        })
      }
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
      getDashboardSnapshot: at => pullRequestStatuses.apply(mergeExternalWatchSnapshot(store.getDashboardSnapshot(at), externalWatch.snapshot())),
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
    allowedHost: config.server.allowedHost,
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
  poller.start()
  externalPoller.start()
  worktreeSweeper.start()
  mutationSchedulers?.tasks.start()
  mutationSchedulers?.baselineRepairs.start()
  mutationSchedulers?.issueWork.start()
  mutationSchedulers?.publications.start()
  mutationSchedulers?.repairs.forEach(scheduler => scheduler.start())
  mutationSchedulers?.reviews.forEach(scheduler => scheduler.start())
  mutationSchedulers?.issues.start()

  return {
    server,
    stop: async () => {
      await Promise.all([
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
      ])
      dashboardShutdown.abort()
      await server.close()
      store.close()
    },
  }
}
