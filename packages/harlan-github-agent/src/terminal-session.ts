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
  repository: string
  subjectNumber: number
}

interface TerminalSessionOptions {
  codexPath?: string
  delayMilliseconds?: number
  terminalPath?: string
  onError?: (error: Error) => void
}

async function executable(path: string): Promise<Result<string, string>> {
  return access(path, constants.X_OK)
    .then(() => ok(path))
    .catch(() => err(`Executable is unavailable: ${path}`))
}

export function createTerminalSessionLauncher(options: TerminalSessionOptions = {}) {
  const terminalPath = options.terminalPath ?? '/usr/bin/ghostty'
  const codexPath = options.codexPath ?? join(homedir(), '.local', 'bin', 'codex')
  const delayMilliseconds = options.delayMilliseconds ?? 6_000

  return async (input: TerminalSessionInput): Promise<Result<void, string>> => {
    if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(input.sessionId))
      return err('The Codex session ID is invalid.')
    const [terminal, codex] = await Promise.all([executable(terminalPath), executable(codexPath)])
    if (terminal._tag === 'Err')
      return terminal
    if (codex._tag === 'Err')
      return codex
    const timer = setTimeout(() => {
      const child = spawn(terminal.value, [
        `--title=Codex · ${input.repository} #${input.subjectNumber}`,
        '-e',
        codex.value,
        'resume',
        input.sessionId,
        '-c',
        'tui.resume_cwd="session"',
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
