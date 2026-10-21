#!/usr/bin/env node
import type { CliCommand } from './cli-arguments.ts'
import type { JsonObject, JsonValue, Result } from './types.ts'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseCliArguments } from './cli-arguments.ts'
import { initConfig, readConfig, resolvePaths, resolveSecrets } from './config.ts'
import { requestControl, startControlServer } from './control.ts'
import { startServer } from './server.ts'
import { createOctorun } from './service.ts'
import { restoreStoreBackup } from './store.ts'
import { err, ok } from './types.ts'

const help = `Octorun runs reactive workflows for your GitHub repositories.

Usage: octorun [--config FILE] [--json] COMMAND

  init --repository OWNER/REPO --repository-id ID --installation-id ID
       --app-id ID --model MODEL [--base-url URL] [--output FILE]
  validate                          Check configuration without credentials
  config [validate]                 Show effective configuration or validate it
  doctor [--online]                 Check setup and optional GitHub access
  serve                             Accept webhooks and process workflow runs
  poll [--backfill existing]         Recover observations and process work
  run --repository OWNER/REPO --pr N [--workflow ID] [--request-id ID]
  plan --repository OWNER/REPO --pr N [--workflow ID]
  status                            Show controller and queue state
  inspect [RUN_ID]                  Show a workflow run or recent runs
  logs [RUN_ID] [--limit N]          Read correlated controller logs
  cancel RUN_ID                     Cancel one workflow run
  pause [--repository OWNER/REPO] [--pr N | --target TARGET_KEY]
  resume [--repository OWNER/REPO] [--pr N | --target TARGET_KEY]
  drain                             Pause admission and finish active attempts
  backup FILE                       Back up durable state
  restore FILE                      Restore state while the controller is stopped
  prune --before ISO_DATE           Remove completed evidence before this date
  version                           Show the package and Node versions

Configuration defaults to $XDG_CONFIG_HOME/octorun/config.yaml.
Secrets come from the environment variables named in that file.
Existing pull requests require explicit --backfill existing selection.
`

function commandRequest(command: CliCommand): { command: string, args: JsonObject } | null {
  switch (command._tag) {
    case 'Run':
    case 'Plan':
      return { command: command._tag.toLowerCase(), args: { repository: command.repository, number: command.number, ...(command.workflow ? { workflow: command.workflow } : {}), ...(command.requestId ? { requestId: command.requestId } : {}) } }
    case 'Poll':
      return { command: 'poll', args: { backfill: command.backfill } }
    case 'Inspect':
      return { command: 'inspect', args: command.runId ? { runId: command.runId } : {} }
    case 'Logs':
      return { command: 'logs', args: { limit: command.limit, ...(command.runId ? { runId: command.runId } : {}) } }
    case 'Cancel':
      return { command: 'cancel', args: { runId: command.runId } }
    case 'Pause':
    case 'Resume':
      return { command: command._tag.toLowerCase(), args: command.scope._tag === 'Controller' ? {} : { repository: command.scope.repository, targetKey: command.scope.targetKey, ...(command.scope.number ? { number: command.scope.number } : {}) } }
    case 'Backup':
      return { command: 'backup', args: { destination: resolve(command.destination) } }
    case 'Restore':
      return { command: 'restore', args: { source: resolve(command.source) } }
    case 'Prune':
      return { command: 'prune', args: { before: command.before } }
    case 'Doctor':
      return command.online ? { command: 'doctor', args: { online: true } } : null
    case 'Status':
    case 'Drain':
      return { command: command._tag.toLowerCase(), args: {} }
    case 'Configuration':
      return { command: 'configuration', args: {} }
    default:
      return null
  }
}

function writeResult(result: Result<JsonValue>, json: boolean, outcome: 'Operation' | 'Run' | 'Doctor' = 'Operation'): number {
  if (result._tag === 'Err') {
    const text = json ? JSON.stringify(result) : result.error.message
    process.stderr.write(`${text}\n`)
    return 1
  }
  process.stdout.write(`${json ? JSON.stringify(result.value) : JSON.stringify(result.value, null, 2)}\n`)
  const value = typeof result.value === 'object' && result.value !== null && !Array.isArray(result.value) ? result.value : null
  if (outcome === 'Doctor' && value?.ready === false)
    return 1
  return outcome === 'Run' && typeof value?.state === 'string' && ['Failed', 'Cancelled', 'Superseded'].includes(value.state) ? 1 : 0
}

function restoreFailure(error: unknown): Result<never> {
  const message = error instanceof Error ? error.message : ''
  if (message === 'Another controller holds the state lock, or its lock database is unavailable.')
    return err({ _tag: 'Configuration', message: 'Restore could not acquire the state lock. Stop the controller and check state directory access before restoring.' })
  if (message === 'The backup is corrupt or uses an incompatible state schema.')
    return err({ _tag: 'Configuration', message: 'Restore failed. Check backup integrity and schema compatibility. Choose a backup created by this Octorun version.' })
  return err({ _tag: 'Configuration', message: 'Restore failed. Check backup integrity, schema compatibility, and file access. Stop the controller before restoring.' })
}

async function main(args: string[]): Promise<number> {
  const parsed = parseCliArguments(args)
  if (parsed._tag === 'Err')
    return writeResult(parsed, args.includes('--json'))
  const command = parsed.value
  if (command._tag === 'Help') {
    process.stdout.write(help)
    return 0
  }
  if (command._tag === 'Version') {
    const metadata: unknown = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const version = typeof metadata === 'object' && metadata !== null && 'version' in metadata ? String(metadata.version) : 'unknown'
    return writeResult(ok({ version, node: process.version }), command.json)
  }
  if (command._tag === 'Init') {
    const result = await initConfig({
      path: command.output ?? command.configPath ?? resolvePaths().configPath,
      repository: command.repository,
      repositoryId: command.repositoryId,
      installationId: command.installationId,
      appId: command.appId,
      model: command.model,
      ...(command.baseUrl ? { baseUrl: command.baseUrl } : {}),
    })
    return writeResult(result._tag === 'Ok' ? ok({ ...result.value, next: 'Set the referenced environment variables, then run octorun doctor.' }) : result, command.json)
  }
  const loaded = await readConfig(command.configPath ? { path: command.configPath } : {})
  if (loaded._tag === 'Err')
    return writeResult(loaded, command.json)
  const config = loaded.value
  if (command._tag === 'Restore') {
    const existing = await requestControl({ path: join(config.stateDir, 'control.sock'), command: 'status', args: {} })
    if (existing !== null)
      return writeResult(existing._tag === 'Err' ? existing : err({ _tag: 'Configuration', message: 'Stop the Octorun controller before restoring a backup.' }), command.json)
    const restored = await restoreStoreBackup({ source: resolve(command.source), destination: join(config.stateDir, 'state.sqlite') })
      .then(() => ok({ restored: true, stateDir: config.stateDir }))
      .catch(restoreFailure)
    return writeResult(restored, command.json)
  }
  if (command._tag === 'Validate')
    return writeResult(ok({ valid: true, repositories: config.repositories.map(repository => repository.fullName), stateDir: config.stateDir }), command.json)
  if (command._tag === 'Doctor' && !command.online) {
    const secrets = resolveSecrets(config)
    if (secrets._tag === 'Err')
      return writeResult(secrets, command.json)
    return writeResult(ok({ configuration: 'valid', node: process.version, repositories: config.repositories.map(repository => repository.fullName), provider: config.provider.model, webhook: secrets.value.webhookSecret ? 'configured' : 'disabled', next: 'Run doctor --online to check GitHub access, then serve or poll.' }), command.json)
  }
  const request = commandRequest(command)
  if (request) {
    const existing = await requestControl({ path: join(config.stateDir, 'control.sock'), ...request })
    if (existing !== null)
      return writeResult(existing, command.json, command._tag === 'Run' ? 'Run' : command._tag === 'Doctor' ? 'Doctor' : 'Operation')
  }
  const created = await createOctorun({ config })
  if (created._tag === 'Err')
    return writeResult(created, command.json)
  const service = created.value
  if (command._tag !== 'Serve') {
    if (!request) {
      await service.close()
      return writeResult(err({ _tag: 'Configuration', message: 'This command does not operate on the controller.' }), command.json)
    }
    const result = await service.command(request.command, request.args).finally(() => service.close())
    return writeResult(result, command.json, command._tag === 'Run' ? 'Run' : command._tag === 'Doctor' ? 'Doctor' : 'Operation')
  }
  const secrets = resolveSecrets(config)
  if (secrets._tag === 'Err') {
    await service.close()
    return writeResult(secrets, command.json)
  }
  const control = await startControlServer({ path: join(config.stateDir, 'control.sock'), handle: service.command }).catch(async (error: unknown) => {
    await service.close()
    throw error
  })
  const server = await startServer({
    host: config.host,
    port: config.port,
    webhookSecret: secrets.value.webhookSecret,
    bodyBytes: config.limits.bodyBytes,
    requestsPerMinute: config.limits.requestsPerMinute,
    readiness: async () => {
      const status = await service.command('status', {})
      return status._tag === 'Ok' && !(typeof status.value === 'object' && status.value !== null && 'ready' in status.value && status.value.ready === false)
    },
    handleWebhook: service.handleWebhook,
    onError: () => process.stderr.write('Webhook ingestion failed. Inspect Octorun logs.\n'),
  }).catch(async (error: unknown) => {
    await control.close()
    await service.close()
    throw error
  })
  await Promise.resolve().then(() => service.start()).catch(async (error: unknown) => {
    await Promise.all([server.close(), control.close()])
    await service.close()
    throw error
  })
  writeResult(ok({ listening: server.url, stateDir: config.stateDir, mode: secrets.value.webhookSecret ? 'webhook-and-poll' : 'poll-only' }), command.json)
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  await Promise.all([server.close(), control.close()])
  await service.close()
  return 0
}

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code
}).catch((error: unknown) => {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'OPERATION_FAILED'
  const message = `Octorun operation failed (${code}). Check configuration, file permissions, and controller logs.`
  process.stderr.write(`${process.argv.includes('--json') ? JSON.stringify({ _tag: 'Err', error: { _tag: 'Permanent', message } }) : message}\n`)
  process.exitCode = 1
})
