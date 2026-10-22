import type { JsonValue, Result } from '@harlan-zw/octorun'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { err, ok } from '@harlan-zw/octorun'

export interface ClaudeAuthenticationOptions {
  command?: string
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

const execute = promisify(execFile)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Check credentials without starting a model turn or exposing account details. */
export async function checkClaudeAuthentication(options: ClaudeAuthenticationOptions = {}): Promise<Result<{ authenticated: true }>> {
  const command = options.command ?? 'claude'
  const args = options.args ?? []
  const timeout = options.timeoutMs ?? 10000
  if (!command || command.includes('\0') || args.length > 32 || args.some(value => value.includes('\0'))
    || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000) {
    return err({ _tag: 'Configuration', message: 'The Claude authentication check configuration is invalid.' })
  }
  const completed = await execute(command, [...args, 'auth', 'status', '--json'], {
    env: options.env ?? process.env,
    cwd: options.env?.HOME ?? homedir(),
    encoding: 'utf8',
    timeout,
    maxBuffer: 16384,
    killSignal: 'SIGKILL',
  }).then(value => ({ _tag: 'Completed' as const, stdout: value.stdout }), (cause: unknown) => {
    if (object(cause) && (cause.code === 'ENOENT' || cause.code === 'EACCES'))
      return { _tag: 'Failed' as const, error: { _tag: 'Configuration' as const, message: 'Cannot start Claude. Install Claude Code and check the controller PATH.' } }
    if (object(cause) && cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      return { _tag: 'Failed' as const, error: { _tag: 'Configuration' as const, message: 'Claude authentication returned excessive output. Check the Claude installation.' } }
    if (object(cause) && (cause.killed === true || cause.code === 'ETIMEDOUT'))
      return { _tag: 'Failed' as const, error: { _tag: 'Transient' as const, message: 'Claude authentication did not respond in time. Retry doctor.' } }
    return { _tag: 'Failed' as const, error: { _tag: 'Authorization' as const, message: 'Claude authentication failed. Run claude auth login, then retry doctor.' } }
  })
  if (completed._tag === 'Failed')
    return err(completed.error)
  const parsed = await Promise.resolve().then(() => JSON.parse(completed.stdout) as unknown).then(value => ({ _tag: 'Parsed' as const, value }), () => ({ _tag: 'Invalid' as const }))
  if (parsed._tag === 'Invalid' || !object(parsed.value) || typeof parsed.value.loggedIn !== 'boolean')
    return err({ _tag: 'Configuration', message: 'Claude authentication returned an invalid response. Check the Claude installation.' })
  return parsed.value.loggedIn
    ? ok({ authenticated: true })
    : err({ _tag: 'Authorization', message: 'Claude authentication failed. Run claude auth login, then retry doctor.' })
}

export function withClaudeReadiness(diagnostic: Result<JsonValue>, authentication: Result<{ authenticated: true }>): Result<JsonValue> {
  if (diagnostic._tag === 'Err')
    return diagnostic
  const value = diagnostic.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || typeof value.provider !== 'object' || value.provider === null || Array.isArray(value.provider)
    || typeof value.ready !== 'boolean') {
    return err({ _tag: 'Configuration', message: 'The controller returned an invalid diagnostic response.' })
  }
  const authenticated = authentication._tag === 'Ok'
  return ok({
    ...value,
    ready: value.ready && authenticated,
    provider: { ...value.provider, configured: authenticated, authenticated, error: authentication._tag === 'Err' ? authentication.error.message : null },
  })
}
