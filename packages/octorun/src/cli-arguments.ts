import type { Result } from './types.ts'
import { err, ok } from './types.ts'

interface CommonOptions { configPath?: string, json: boolean }
export type CliCommand = CommonOptions & (
  | { _tag: 'Help' | 'Version' | 'Validate' | 'Configuration' | 'Status' | 'Serve' | 'Drain' }
  | { _tag: 'Doctor', online: boolean }
  | { _tag: 'Init', output?: string, repository: string, repositoryId: number, installationId: number, appId: string, model: string, baseUrl?: string }
  | { _tag: 'Poll', backfill: boolean }
  | { _tag: 'Run' | 'Plan', repository: string, number: number, workflow?: string, requestId?: string }
  | { _tag: 'Inspect', runId?: string }
  | { _tag: 'Logs', runId?: string, limit: number }
  | { _tag: 'Cancel', runId: string }
  | { _tag: 'Pause' | 'Resume', scope: { _tag: 'Controller' } | { _tag: 'Repository', repository: string, targetKey: string | null, number?: number } }
  | { _tag: 'Backup', destination: string }
  | { _tag: 'Restore', source: string }
  | { _tag: 'Prune', before: string }
)

const failure = (message: string): Result<never> => err({ _tag: 'Configuration', message })
const valueOptions = new Set(['config', 'output', 'repository', 'repository-id', 'installation-id', 'app-id', 'model', 'base-url', 'pr', 'workflow', 'request-id', 'backfill', 'run', 'limit', 'target', 'before'])
const booleanOptions = new Set(['json', 'help', 'version', 'online'])
const number = (value: string | undefined): number | null => value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null

export function parseCliArguments(args: string[]): Result<CliCommand> {
  args = args.map(argument => argument === '-h' ? '--help' : argument === '-v' ? '--version' : argument === '-c' ? '--config' : argument)
  const values: Record<string, string> = {}
  const flags = new Set<string>()
  const positionals: string[] = []
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (!argument.startsWith('--')) {
      positionals.push(argument)
      continue
    }
    const split = argument.indexOf('=')
    const key = argument.slice(2, split < 0 ? undefined : split)
    if (flags.has(key) || values[key] !== undefined)
      return failure(`Option --${key} was repeated.`)
    if (booleanOptions.has(key)) {
      if (split >= 0)
        return failure(`Option --${key} does not take a value.`)
      flags.add(key)
      continue
    }
    if (!valueOptions.has(key))
      return failure(`Unknown option --${key}. Run octorun help for supported commands.`)
    const value = split < 0 ? args[++index] : argument.slice(split + 1)
    if (!value || value.startsWith('--'))
      return failure(`Option --${key} needs a value.`)
    values[key] = value
  }
  const common: CommonOptions = { ...(values.config ? { configPath: values.config } : {}), json: flags.has('json') }
  if (flags.has('help') || positionals[0] === 'help' || args.length === 0)
    return ok({ ...common, _tag: 'Help' })
  if (flags.has('version') || positionals[0] === 'version')
    return ok({ ...common, _tag: 'Version' })
  let command = positionals.shift()
  if (command === 'config' && positionals[0] === 'validate') {
    command = 'validate'
    positionals.shift()
  }
  const allowed: Record<string, string[]> = {
    init: ['output', 'repository', 'repository-id', 'installation-id', 'app-id', 'model', 'base-url'],
    validate: [],
    config: [],
    doctor: ['online'],
    serve: [],
    status: [],
    poll: ['backfill'],
    run: ['repository', 'pr', 'workflow', 'request-id'],
    plan: ['repository', 'pr', 'workflow', 'request-id'],
    inspect: ['run'],
    logs: ['run', 'limit'],
    cancel: ['run'],
    pause: ['repository', 'target', 'pr'],
    resume: ['repository', 'target', 'pr'],
    backup: [],
    restore: [],
    drain: [],
    prune: ['before'],
  }
  if (!command || !allowed[command])
    return failure('Unknown command. Run octorun help for supported commands.')
  const unexpected = [...Object.keys(values), ...flags].find(key => !['config', 'json'].includes(key) && !allowed[command]!.includes(key))
  if (unexpected)
    return failure(`Option --${unexpected} does not apply to ${command}.`)
  const positional = positionals.shift()
  if (positionals.length > 0 || (positional && !['inspect', 'logs', 'cancel', 'backup', 'restore'].includes(command)))
    return failure(`Unexpected argument for ${command}. Run octorun help for its syntax.`)
  if (command === 'init') {
    const repositoryId = number(values['repository-id'])
    const installationId = number(values['installation-id'])
    if (!values.repository || !repositoryId || !installationId || !values['app-id'] || !values.model)
      return failure('init needs --repository, --repository-id, --installation-id, --app-id, and --model.')
    return ok({ ...common, _tag: 'Init', repository: values.repository, repositoryId, installationId, appId: values['app-id'], model: values.model, ...(values.output ? { output: values.output } : {}), ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}) })
  }
  if (command === 'doctor')
    return ok({ ...common, _tag: 'Doctor', online: flags.has('online') })
  if (command === 'poll') {
    if (values.backfill && values.backfill !== 'existing')
      return failure('Use --backfill existing to select existing pull requests explicitly.')
    return ok({ ...common, _tag: 'Poll', backfill: values.backfill === 'existing' })
  }
  if (command === 'run' || command === 'plan') {
    const pr = number(values.pr)
    if (!values.repository || !pr)
      return failure(`${command} needs --repository owner/repository and --pr number.`)
    return ok({ ...common, _tag: command === 'run' ? 'Run' : 'Plan', repository: values.repository, number: pr, ...(values.workflow ? { workflow: values.workflow } : {}), ...(values['request-id'] ? { requestId: values['request-id'] } : {}) })
  }
  if (command === 'inspect' || command === 'logs') {
    const runId = positional ?? values.run
    if (positional && values.run)
      return failure('Provide the run ID once.')
    if (command === 'inspect')
      return ok({ ...common, _tag: 'Inspect', ...(runId ? { runId } : {}) })
    const limit = values.limit ? number(values.limit) : 100
    if (!limit || limit > 1000)
      return failure('logs --limit must be between 1 and 1000.')
    return ok({ ...common, _tag: 'Logs', ...(runId ? { runId } : {}), limit })
  }
  if (command === 'cancel') {
    const runId = positional ?? values.run
    if (!runId || (positional && values.run))
      return failure('cancel needs one run ID.')
    return ok({ ...common, _tag: 'Cancel', runId })
  }
  if (command === 'pause' || command === 'resume') {
    if (!values.repository) {
      if (values.pr || values.target)
        return failure('Target controls need --repository owner/repository.')
      return ok({ ...common, _tag: command === 'pause' ? 'Pause' : 'Resume', scope: { _tag: 'Controller' } })
    }
    const pr = values.pr ? number(values.pr) : null
    if ((values.pr && !pr) || (values.pr && values.target))
      return failure('Use one valid --pr number or --target key for the pause scope.')
    return ok({ ...common, _tag: command === 'pause' ? 'Pause' : 'Resume', scope: { _tag: 'Repository', repository: values.repository, targetKey: values.target ?? null, ...(pr ? { number: pr } : {}) } })
  }
  if (command === 'backup' || command === 'restore') {
    if (!positional)
      return failure(`${command} needs a backup file path.`)
    return ok(command === 'backup' ? { ...common, _tag: 'Backup', destination: positional } : { ...common, _tag: 'Restore', source: positional })
  }
  if (command === 'prune') {
    const before = values.before
    if (!before || !Number.isFinite(Date.parse(before)))
      return failure('prune needs --before with an ISO date or timestamp.')
    return ok({ ...common, _tag: 'Prune', before: new Date(before).toISOString() })
  }
  const tags = { validate: 'Validate', config: 'Configuration', serve: 'Serve', status: 'Status', drain: 'Drain' } as const
  return ok({ ...common, _tag: tags[command as keyof typeof tags] })
}
