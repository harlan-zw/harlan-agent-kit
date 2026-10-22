import type { JsonValue, Result } from '@harlan-zw/octorun'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { err, requestControl, startControlServer } from '@harlan-zw/octorun'
import { kitExitCode, kitOperation, parseKitCommand } from './commands.ts'
import { createKitHost } from './host.ts'

const help = `Octorun workflows for Harlan Agent Kit

pnpm octorun serve
pnpm octorun doctor
pnpm octorun plan --pr NUMBER
pnpm octorun run --pr NUMBER [--workflow adversarial-review]
pnpm octorun poll [--backfill existing]
pnpm octorun status
pnpm octorun inspect RUN_ID
pnpm octorun logs [RUN_ID]
pnpm octorun pause|resume|drain
pnpm octorun cancel RUN_ID
pnpm octorun backup FILE

The default workflow writes change summaries.
Use @octorun review on GitHub for an explicit adversarial review.
The existing Service keeps automatic Review, Repair, and releases.

--config PATH selects the existing Service configuration.
OCTORUN_KIT_STATE_DIR selects separate Octorun state.
OCTORUN_KIT_MODEL selects the Claude model. Default: claude-opus-5-5.
`

function print(result: Result<JsonValue>): void {
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = kitExitCode(result)
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseKitCommand(argv)
  if (parsed._tag === 'Err') {
    print(parsed)
    return
  }
  if (parsed.value._tag === 'Help') {
    process.stdout.write(help)
    return
  }
  const stateDir = resolve(process.env.OCTORUN_KIT_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'octorun-kit'))
  const socketPath = join(stateDir, 'control.sock')
  const operation = parsed.value._tag === 'Serve' ? null : kitOperation(parsed.value)
  if (operation?._tag === 'Err') {
    print(operation)
    return
  }
  if (operation?._tag === 'Ok') {
    const response = await requestControl({ path: socketPath, ...operation.value, timeoutMs: 900000 })
    if (response !== null) {
      print(response)
      return
    }
  }
  const host = await createKitHost({
    configurationPath: parsed.value.configPath ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'harlan-github-agent/config.yml'),
    stateDir,
    model: process.env.OCTORUN_KIT_MODEL ?? 'claude-opus-5-5',
    env: process.env,
  })
  if (host._tag === 'Err') {
    print(host)
    return
  }
  const service = host.value
  try {
    if (operation?._tag === 'Ok') {
      print(await service.command(operation.value.command, operation.value.args))
      return
    }
    const control = await startControlServer({ path: socketPath, handle: service.command })
    const abort = new AbortController()
    const stop = () => abort.abort()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      await service.start()
      process.stdout.write(`${JSON.stringify({ _tag: 'Ok', value: { serving: true, repository: 'harlan-zw/harlan-agent-kit', stateDir } })}\n`)
      await new Promise<void>((complete) => {
        if (abort.signal.aborted)
          complete()
        else
          abort.signal.addEventListener('abort', () => complete(), { once: true })
      })
    }
    finally {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
      await control.close()
    }
  }
  finally {
    await service.close()
  }
}

main(process.argv.slice(2)).catch(() => {
  print(err({ _tag: 'Transient', message: 'Octorun could not complete this operation. Check controller ownership, file permissions, and network access.' }))
})
