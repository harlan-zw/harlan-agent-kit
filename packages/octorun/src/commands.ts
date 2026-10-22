import type { CliCommand, JsonObject, JsonValue, Result } from '@harlan-zw/octorun'
import { err, ok, parseCliArguments } from '@harlan-zw/octorun'
import { KIT_REPOSITORY } from './config.ts'

export function parseKitCommand(argv: string[]): Result<CliCommand> {
  const valueOptions = new Set(['--config', '-c', '--pr', '--repository', '--workflow', '--request-id', '--backfill', '--run', '--limit', '--target', '--before'])
  let command: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!
    if (valueOptions.has(value)) {
      index++
      continue
    }
    if (!value.startsWith('-')) {
      command = value
      break
    }
  }
  const arguments_ = [...argv]
  if (['run', 'plan'].includes(command ?? '')) {
    if (!argv.some(value => value === '--repository' || value.startsWith('--repository=')))
      arguments_.push('--repository', KIT_REPOSITORY)
    if (!argv.some(value => value === '--workflow' || value.startsWith('--workflow=')))
      arguments_.push('--workflow', 'change-summary')
  }
  const parsed = parseCliArguments(arguments_)
  if (parsed._tag === 'Err')
    return parsed
  if (['Init', 'Restore', 'Validate', 'Configuration', 'Version'].includes(parsed.value._tag))
    return err({ _tag: 'Configuration', message: 'This command belongs to the standalone Octorun CLI. Run pnpm octorun help for Kit commands.' })
  if (('repository' in parsed.value && parsed.value.repository !== KIT_REPOSITORY) || ((parsed.value._tag === 'Pause' || parsed.value._tag === 'Resume') && parsed.value.scope._tag === 'Repository' && parsed.value.scope.repository !== KIT_REPOSITORY))
    return err({ _tag: 'Authorization', message: 'This Octorun controller serves harlan-zw/harlan-agent-kit only.' })
  return parsed
}

export function kitOperation(command: CliCommand): Result<{ command: string, args: JsonObject }> {
  switch (command._tag) {
    case 'Doctor': return ok({ command: 'doctor', args: {} })
    case 'Status': return ok({ command: 'status', args: {} })
    case 'Poll': return ok({ command: 'poll', args: { backfill: command.backfill } })
    case 'Run':
    case 'Plan': return ok({ command: command._tag.toLowerCase(), args: { repository: KIT_REPOSITORY, number: command.number, workflow: command.workflow ?? 'change-summary', ...(command.requestId ? { requestId: command.requestId } : {}) } })
    case 'Inspect': return ok({ command: 'inspect', args: command.runId ? { runId: command.runId } : {} })
    case 'Logs': return ok({ command: 'logs', args: { limit: command.limit, ...(command.runId ? { runId: command.runId } : {}) } })
    case 'Cancel': return ok({ command: 'cancel', args: { runId: command.runId } })
    case 'Pause':
    case 'Resume': return ok({ command: command._tag.toLowerCase(), args: command.scope._tag === 'Controller' ? {} : { repository: KIT_REPOSITORY, targetKey: command.scope.targetKey, ...(command.scope.number ? { number: command.scope.number } : {}) } })
    case 'Drain': return ok({ command: 'drain', args: {} })
    case 'Backup': return ok({ command: 'backup', args: { destination: command.destination } })
    case 'Prune': return ok({ command: 'prune', args: { before: command.before } })
    default: return err({ _tag: 'Configuration', message: 'This command does not execute a workflow operation.' })
  }
}

export function kitExitCode(result: Result<JsonValue>): number {
  if (result._tag === 'Err')
    return 1
  const value = result.value
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if (value.ready === false || (typeof value.state === 'string' && ['Failed', 'Cancelled', 'Superseded'].includes(value.state)))
      return 1
  }
  return 0
}
