#!/usr/bin/env node
import type { AgentEvent, AgentProvider } from './agent-provider.ts'
import type { DesktopTurn } from './desktop-broker.ts'
import type { DesktopWorktree } from './desktop-worktree.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultAgentContextPaths, loadAgentContext, opencodeAgentEnvironment } from './agent-context.ts'
import { createCodexProvider } from './codex-provider.ts'
import { parseDesktopWorktree } from './desktop-protocol.ts'
import { desktopRepositoryPath, exportDesktopWorktree, prepareDesktopWorktree } from './desktop-worktree.ts'
import { createOpencodeProvider } from './opencode-provider.ts'

/** Run a provider in an isolated desktop Worktree and return its exact changes. */
export async function executeDesktopTurn(options: {
  turn: DesktopTurn
  directory: string
  /** Where cached control checkouts live, one per repository, across every task. */
  repositories: string
  provider: AgentProvider
  signal: AbortSignal
  emit: (event: AgentEvent) => void
  capture?: (worktree: DesktopWorktree) => Promise<void>
}): Promise<DesktopWorktree> {
  const { turn, directory, provider, signal } = options
  const snapshot = parseDesktopWorktree(turn.worktree)
  const cache = desktopRepositoryPath(options.repositories, snapshot.origin)
  const workspace = await prepareDesktopWorktree(snapshot, cache, join(directory, 'worktree'), signal)
  const request = {
    ...turn.request,
    workspace,
    prompt: turn.request.prompt.replaceAll(turn.request.workspace, workspace),
    instructionPaths: [],
    signal,
  }
  const output = join(directory, 'output')
  await mkdir(output, { recursive: true })
  try {
    for await (const event of provider.runTurn(request)) {
      const mapped = JSON.parse(JSON.stringify(event).replaceAll(workspace, turn.request.workspace)) as AgentEvent
      options.emit(mapped)
    }
  }
  catch (error) {
    // Keep edits from a failed or interrupted turn available for recovery.
    const result = await exportDesktopWorktree(workspace, output, { signal: AbortSignal.timeout(30_000), against: snapshot.head })
    await options.capture?.(result)
    throw error
  }
  const result = await exportDesktopWorktree(workspace, output, { signal, against: snapshot.head })
  await options.capture?.(result)
  return result
}

async function main(): Promise<void> {
  const input = process.argv[2]
  if (input === undefined)
    throw new Error('Desktop turn file is required.')
  const turn = JSON.parse(await readFile(input, 'utf8')) as DesktopTurn
  const controller = new AbortController()
  process.once('SIGTERM', () => controller.abort())
  process.once('SIGINT', () => controller.abort())
  const context = await loadAgentContext(defaultAgentContextPaths())
  if (context._tag === 'Err')
    throw new Error(context.error)
  const environment = opencodeAgentEnvironment({ context: context.value, environment: process.env })
  if (environment._tag === 'Err')
    throw new Error(environment.error)
  const provider = turn.provider === 'codex' ? createCodexProvider() : createOpencodeProvider({ environment: environment.value })
  await executeDesktopTurn({
    turn,
    directory: dirname(input),
    // One level above the task directory, so every task on a repository reuses
    // the same checkout.
    repositories: join(dirname(dirname(input)), 'repositories'),
    provider,
    signal: controller.signal,
    emit: event => process.stdout.write(`${JSON.stringify(event)}\n`),
    capture: result => writeFile(join(dirname(input), 'result.json'), JSON.stringify(result), { mode: 0o600 }),
  })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
