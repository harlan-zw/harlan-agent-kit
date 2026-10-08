#!/usr/bin/env node
import type { AgentEvent, AgentProvider } from './agent-provider.ts'
import type { SessionTurn } from './session-protocol.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultAgentContextPaths, loadAgentContext, opencodeAgentEnvironment } from './agent-context.ts'
import { acquireDesktopSessionClaim } from './desktop-session-claim.ts'
import { prepareDesktopSessionWorkspace } from './desktop-session-projects.ts'
import { createDesktopSessionProvider } from './desktop-session-provider.ts'

export async function executeDesktopSessionTurn(options: {
  turn: SessionTurn
  home: string
  signal: AbortSignal
  provider: AgentProvider
  emit: (event: AgentEvent) => Promise<void>
  prepared: (workspace: string) => Promise<void>
}): Promise<{ workspacePath: string, providerSessionId: string | null }> {
  const { turn, signal } = options
  const workspacePath = await prepareDesktopSessionWorkspace(options.home, turn.project.id, turn.sessionId, turn.workspacePath, signal)
  await options.prepared(workspacePath)
  let providerSessionId = turn.providerSessionId
  let failure: string | null = null
  let completed = false
  for await (const event of options.provider.runTurn({
    workspace: workspacePath,
    prompt: `Session context:
Workspace: ${workspacePath}
Claim owner: ${turn.sessionId}
This Session already owns the current Worktree and its global claim.
The controller renews this claim and releases it after all Session processes stop.
If you acquire or renew the claim, use this owner.
Reuse this task-owned Worktree for ordinary Session work.
Do not create another Worktree for ordinary Session work.

User request:
${turn.prompt}`,
    model: turn.model,
    reasoningEffort: turn.reasoningEffort,
    sessionId: providerSessionId,
    outputSchema: undefined,
    signal,
  })) {
    if (event._tag === 'SessionStarted')
      providerSessionId = event.sessionId
    if (event._tag === 'Failed')
      failure = event.reason
    if (event._tag === 'TurnCompleted')
      completed = true
    await options.emit(event)
  }
  if (failure !== null)
    throw new Error(failure)
  signal.throwIfAborted()
  if (!completed)
    throw new Error('The Agent did not complete this turn.')
  return { workspacePath, providerSessionId }
}
async function main() {
  const input = process.argv[2]
  if (input === undefined)
    throw new Error('A session turn file is required.')
  const turn = JSON.parse(await readFile(input, 'utf8')) as SessionTurn
  const signal = new AbortController()
  process.once('SIGTERM', () => signal.abort())
  process.once('SIGINT', () => signal.abort())
  const context = await loadAgentContext(defaultAgentContextPaths())
  if (context._tag === 'Err')
    throw new Error(context.error)
  const environment = opencodeAgentEnvironment({ context: context.value, environment: process.env })
  if (environment._tag === 'Err')
    throw new Error(environment.error)
  const directory = dirname(input)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lock = join(dirname(directory), 'execution.lock')
  const previous = await readFile(lock, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
  if (previous !== null) {
    const pid = Number(previous)
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('The session lock is invalid.')
    throw new Error('Stop the previous session turn before resuming it.')
  }
  await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
  let result = { workspacePath: turn.workspacePath, providerSessionId: turn.providerSessionId }
  const capture = () => writeFile(join(directory, 'result.json'), JSON.stringify(result), { mode: 0o600 })
  result = await executeDesktopSessionTurn({
    turn,
    home: process.argv[3] ?? homedir(),
    signal: signal.signal,
    provider: createDesktopSessionProvider({ provider: turn.provider, environment: environment.value }),
    prepared: async (workspacePath) => {
      await acquireDesktopSessionClaim(workspacePath, turn.sessionId)
      await writeFile(join(directory, 'claim.json'), JSON.stringify({ workspacePath, sessionId: turn.sessionId }), { mode: 0o600 })
      result.workspacePath = workspacePath
      await capture()
    },
    emit: async (event) => {
      if (event._tag === 'SessionStarted') {
        result.providerSessionId = event.sessionId
        await capture()
      }
      process.stdout.write(`${JSON.stringify(event)}\n`)
    },
  }).finally(async () => {
    await capture()
  })
  await capture()
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
