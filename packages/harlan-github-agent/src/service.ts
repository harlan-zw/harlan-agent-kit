import type { ConsolaInstance } from 'consola'
import type { Server } from 'srvx'
import type { GitIdentity } from './git-identity.ts'
import type { RepositoryMapping, ValidatedAgentConfig } from './types.ts'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createAgentActivityLog } from './agent-activity.ts'
import { createAgentPermitPool } from './agent-permit-pool.ts'
import { createAgentApp } from './app.ts'
import { createApprovalController } from './approval-controller.ts'
import { createCodexBaselineRepairWorker } from './baseline-repair-worker.ts'
import { CODEX_WORKER_PROFILE } from './codex-worker-profile.ts'
import { validateRepositoryMappings } from './config.ts'
import { createCodexConflictWorker } from './conflict-worker.ts'
import { createExternalWatchController, mergeExternalWatchSnapshot } from './external-watch.ts'
import { createGitHubAppTokenProvider } from './github-auth.ts'
import { createGitHubWorkerSource } from './github-worker-source.ts'
import { createGitHubPullRequestPublisher, createGitHubSource } from './github.ts'
import { createIssueTriageCommentController } from './issue-triage-comment-controller.ts'
import { createCodexIssueWorkWorker } from './issue-work-worker.ts'
import { createPoller } from './poller.ts'
import { createPublicationScheduler } from './publication-scheduler.ts'
import { createPullRequestStatusController } from './pull-request-status-controller.ts'
import { reconcileAllRepositories } from './reconcile.ts'
import { buildRepositoryMappings, discoverGitHubAppRepositories, discoverLocalCheckouts } from './repository-discovery.ts'
import { err, ok } from './result.ts'
import { syncReviewRerunRequests } from './review-rerun-controller.ts'
import { createReviewStatusController } from './review-status-controller.ts'
import { startAgentServer } from './server.ts'
import { openJournalStore } from './store.ts'
import { createCodexIssueTriageWorker, createCodexReviewWorker } from './subject-worker.ts'
import { createTaskScheduler } from './task-scheduler.ts'
import { createTerminalSessionLauncher } from './terminal-session.ts'
import { createWorkerTaskScheduler } from './worker-task-scheduler.ts'
import { createBaselineRepairWorktreeManager, createConflictWorktreeManager, createGitPublicationRemote, createIssueWorktreeManager, createReviewFixWorktreeManager, createWorkerWorkspaceManager } from './worktree.ts'

export interface RunningAgentService {
  server: Server
  stop: () => Promise<void>
}

export interface StartAgentServiceOptions {
  config: ValidatedAgentConfig
  dashboardPassword: string
  githubPrivateKey: string
  gitIdentity: GitIdentity
  logger: Pick<ConsolaInstance, 'error' | 'info'>
  now?: () => Date
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
  const discoveredMappings = buildRepositoryMappings(installedRepositories, localCheckouts, options.config.repositories, options.config.github.allowedOwners)
  const validatedDiscovery = await validateRepositoryMappings({ ...options.config, repositories: discoveredMappings })
  if (validatedDiscovery._tag === 'Err')
    throw new Error(validatedDiscovery.error.map(issue => `${issue.path}: ${issue.message}`).join(' '))
  const config = validatedDiscovery.value
  options.logger.info(`GitHub App grants ${installedRepositories.length} repositories. Found ${config.repositories.length} trusted checkouts.`)

  const store = openJournalStore(config.storage.path, config.mutationsEnabled)
  const startedAt = now().toISOString()
  store.syncRepositories(config.repositories, startedAt)
  if (config.mutationsEnabled) {
    const recovered = store.recoverInterruptedAgentTasks(startedAt)
    if (recovered > 0)
      options.logger.info(`Recovered ${recovered} interrupted agent tasks.`)
    const retried = store.retryRecoverableWorkerFailures(startedAt)
    if (retried > 0)
      options.logger.info(`Retried ${retried} tasks after recoverable controller failures were repaired.`)
  }
  const tokens = createGitHubAppTokenProvider({
    appId: config.github.appId,
    privateKey: options.githubPrivateKey,
  })
  const github = createGitHubSource({ tokens, issueCutoff: config.issueCutoff })
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
  const mutationSchedulers = await (async () => {
    if (!config.mutationsEnabled)
      return undefined
    const controllerRoot = join(dirname(config.storage.path), 'worktrees')
    const worktrees = createConflictWorktreeManager({
      gitIdentity: options.gitIdentity,
      root: controllerRoot,
      tokens,
    })
    const workspaces = createWorkerWorkspaceManager({ root: controllerRoot, tokens })
    const fixWorktrees = createReviewFixWorktreeManager({ gitIdentity: options.gitIdentity, root: controllerRoot, tokens })
    const baselineWorktrees = createBaselineRepairWorktreeManager({ gitIdentity: options.gitIdentity, root: controllerRoot, tokens })
    const issueWorktrees = createIssueWorktreeManager({ gitIdentity: options.gitIdentity, root: controllerRoot, tokens })
    const workerGithub = createGitHubWorkerSource({ actorLogin: 'harlan-github-agent[bot]', tokens })
    const permits = createAgentPermitPool(CODEX_WORKER_PROFILE.maximumActiveAgents)
    const canClaim = () => store.getAgentControl()._tag === 'Running'
    const validateMapping = async (mapping: RepositoryMapping) => {
      const validated = await validateRepositoryMappings({ ...config, repositories: [mapping] })
      if (validated._tag === 'Err')
        return err(validated.error.map(issue => `${issue.path}: ${issue.message}`).join(' '))
      const current = validated.value.repositories[0]
      return current === undefined ? err('Repository mapping disappeared during validation.') : ok(current)
    }
    const conflictWorker = createCodexConflictWorker({
      activityLog,
      github,
      now,
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
      repairs: fixWorktrees,
      store,
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
        worker: createCodexBaselineRepairWorker({
          activityLog,
          github: workerGithub,
          now,
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
        worker: createCodexIssueTriageWorker(subjectWorkerOptions),
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
      reviews: Array.from({ length: CODEX_WORKER_PROFILE.maximumActiveAgents }, () => createWorkerTaskScheduler({
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
        worker: createCodexReviewWorker(subjectWorkerOptions),
        workerId: randomUUID(),
      })),
      issueWork: createTaskScheduler({
        canClaim,
        claim: store.claimNextIssueWorkTask,
        intervalMilliseconds: 5_000,
        leaseMilliseconds: 45 * 60_000,
        now,
        onError: error => options.logger.error(error),
        onTaskSettled: activityLog.clear,
        permits,
        store,
        worker: createCodexIssueWorkWorker({
          github: workerGithub,
          activityLog,
          now,
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
  const poller = createPoller({
    intervalMilliseconds: config.pollIntervalSeconds * 1_000,
    poll: async (signal) => {
      const results = await reconcileAllRepositories(config.repositories, {
        ...(mutationSchedulers === undefined ? {} : { approvals: mutationSchedulers.approvals }),
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
        if (result._tag === 'Err')
          options.logger.error(`Review rerun command: ${result.error}`)
        else if (result.value.results.some(item => item._tag === 'Queued'))
          options.logger.info(`${result.value.repository}: queued a requested review rerun.`)
      })
      const statusSync = await pullRequestStatuses.sync(store.getDashboardSnapshot(now().toISOString()), signal)
      statusSync.errors.forEach(error => options.logger.error(`Pull request status: ${error}`))
      if (results.some(result => result._tag === 'Err'))
        throw new Error('One or more repository reconciliations failed.')
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
  const dashboardShutdown = new AbortController()
  const app = createAgentApp({
    activityLog,
    ejectAgent: createTerminalSessionLauncher({ onError: error => options.logger.error(error) }),
    store: {
      approveIssueWork: store.approveIssueWork,
      approvePullRequest: store.approvePullRequest,
      cancelTask: store.cancelTask,
      getDashboardSnapshot: at => pullRequestStatuses.apply(mergeExternalWatchSnapshot(store.getDashboardSnapshot(at), externalWatch.snapshot())),
      listReviewAttempts: store.listReviewAttempts,
      pauseAgents: store.pauseAgents,
      requestReviewRerun: store.requestReviewRerun,
      resumeAgents: store.resumeAgents,
      setRepositoryPaused: store.setRepositoryPaused,
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
  mutationSchedulers?.tasks.start()
  mutationSchedulers?.baselineRepairs.start()
  mutationSchedulers?.issueWork.start()
  mutationSchedulers?.publications.start()
  mutationSchedulers?.reviews.forEach(scheduler => scheduler.start())
  mutationSchedulers?.issues.start()

  return {
    server,
    stop: async () => {
      await Promise.all([
        poller.stop(),
        externalPoller.stop(),
        mutationSchedulers?.tasks.stop() ?? Promise.resolve(),
        mutationSchedulers?.baselineRepairs.stop() ?? Promise.resolve(),
        mutationSchedulers?.issueWork.stop() ?? Promise.resolve(),
        mutationSchedulers?.publications.stop() ?? Promise.resolve(),
        ...(mutationSchedulers?.reviews.map(scheduler => scheduler.stop()) ?? []),
        mutationSchedulers?.issues.stop() ?? Promise.resolve(),
      ])
      dashboardShutdown.abort()
      await server.close()
      store.close()
    },
  }
}
