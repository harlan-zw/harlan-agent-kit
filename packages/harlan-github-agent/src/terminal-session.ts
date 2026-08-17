import type { AgentProviderName } from './agent-provider.ts'
import type { Result } from './result.ts'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { err, ok } from './result.ts'

export interface TerminalSessionInput {
  taskId: string
  sessionId: string
  provider: AgentProviderName
  repository: string
  itemNumber: number
}

interface TerminalSessionOptions {
  codexPath?: string
  opencodePath?: string
  delayMilliseconds?: number
  terminalPath?: string
  onError?: (error: Error) => void
}

const sessionPatterns: Record<AgentProviderName, RegExp> = {
  codex: /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i,
  opencode: /^ses_[a-z\d]{8,}$/i,
}

const providerLabels: Record<AgentProviderName, string> = {
  codex: 'Codex',
  opencode: 'opencode',
}

async function executable(path: string): Promise<Result<string, string>> {
  return access(path, constants.X_OK)
    .then(() => ok(path))
    .catch(() => err(`Executable is unavailable: ${path}`))
}

export function createTerminalSessionLauncher(options: TerminalSessionOptions = {}) {
  const terminalPath = options.terminalPath ?? '/usr/bin/ghostty'
  const agentPaths: Record<AgentProviderName, string> = {
    codex: options.codexPath ?? join(homedir(), '.local', 'bin', 'codex'),
    opencode: options.opencodePath ?? join(homedir(), '.opencode', 'bin', 'opencode'),
  }
  const delayMilliseconds = options.delayMilliseconds ?? 6_000

  return async (input: TerminalSessionInput): Promise<Result<void, string>> => {
    if (!sessionPatterns[input.provider].test(input.sessionId))
      return err('The agent session ID is invalid.')
    const [terminal, agent] = await Promise.all([executable(terminalPath), executable(agentPaths[input.provider])])
    if (terminal._tag === 'Err')
      return terminal
    if (agent._tag === 'Err')
      return agent
    const resumeArguments = input.provider === 'codex'
      ? ['resume', input.sessionId, '-c', 'tui.resume_cwd="session"']
      : ['--session', input.sessionId]
    const timer = setTimeout(() => {
      const child = spawn(terminal.value, [
        `--title=${providerLabels[input.provider]} · ${input.repository} #${input.itemNumber}`,
        '-e',
        agent.value,
        ...resumeArguments,
      ], {
        detached: true,
        env: process.env,
        stdio: 'ignore',
      })
      child.on('error', error => options.onError?.(error))
      child.unref()
    }, delayMilliseconds)
    timer.unref()
    return ok(undefined)
  }
}
