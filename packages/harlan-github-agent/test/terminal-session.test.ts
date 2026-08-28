import type { TerminalSessionInput } from '../src/terminal-session.ts'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { createTerminalSessionLauncher } from '../src/terminal-session.ts'

function input(overrides: Partial<TerminalSessionInput> = {}): TerminalSessionInput {
  return {
    taskId: '101',
    sessionId: 'ses_abc12345',
    provider: 'opencode',
    repository: 'harlan-zw/harlan-agent-kit',
    itemNumber: 82,
    ...overrides,
  }
}

/** The fake terminal records the arguments ghostty would receive, one per line. */
async function recordedArguments(terminalPath: string): Promise<string[] | undefined> {
  for (let attempt = 0; attempt < 100; attempt++) {
    // The argv file exists only once the terminal has spawned, so a missing
    // file is the normal state while polling.
    const content = await readFile(`${terminalPath}.argv`, 'utf8').catch(() => {
      // Ignored: the poll below retries until the terminal records its arguments.
      return undefined
    })
    const lines = content?.split('\n').filter(line => line.length > 0)
    if (lines !== undefined && lines.at(-1) === 'done')
      return lines.slice(0, -1)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return undefined
}

describe('createTerminalSessionLauncher', () => {
  it('finds the installed opencode command through PATH', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'terminal-session-'))
    const binary = join(workspace, 'bin', 'opencode')
    const terminal = join(workspace, 'ghostty')
    const originalPath = process.env.PATH
    const originalHome = process.env.HOME
    await mkdir(join(workspace, 'bin'))
    await writeFile(terminal, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$0.argv"\necho done >> "$0.argv"\n')
    await chmod(terminal, 0o755)
    await writeFile(binary, '#!/bin/sh\nexit 0\n')
    await chmod(binary, 0o755)
    process.env.HOME = workspace
    process.env.PATH = join(workspace, 'bin')

    try {
      const launcher = createTerminalSessionLauncher({ terminalPath: terminal, delayMilliseconds: 0 })

      expect(await launcher(input())).toEqual({ _tag: 'Ok', value: undefined })
      expect(await recordedArguments(terminal)).toEqual([
        '--title=opencode · harlan-zw/harlan-agent-kit #82',
        '-e',
        binary,
        '--session',
        'ses_abc12345',
      ])
    }
    finally {
      process.env.PATH = originalPath
      process.env.HOME = originalHome
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('finds the installed codex command through PATH', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'terminal-session-'))
    const binary = join(workspace, 'bin', 'codex')
    const terminal = join(workspace, 'ghostty')
    const originalPath = process.env.PATH
    const originalHome = process.env.HOME
    await mkdir(join(workspace, 'bin'))
    await writeFile(terminal, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$0.argv"\necho done >> "$0.argv"\n')
    await chmod(terminal, 0o755)
    await writeFile(binary, '#!/bin/sh\nexit 0\n')
    await chmod(binary, 0o755)
    process.env.HOME = workspace
    process.env.PATH = join(workspace, 'bin')

    try {
      const launcher = createTerminalSessionLauncher({ terminalPath: terminal, delayMilliseconds: 0 })

      expect(await launcher(input({ provider: 'codex', sessionId: '0f0e0d0c-0b0a-4968-8956-2631d0c871f9' })))
        .toEqual({ _tag: 'Ok', value: undefined })
      expect(await recordedArguments(terminal)).toEqual([
        '--title=Codex · harlan-zw/harlan-agent-kit #82',
        '-e',
        binary,
        'resume',
        '0f0e0d0c-0b0a-4968-8956-2631d0c871f9',
        '-c',
        'tui.resume_cwd="session"',
      ])
    }
    finally {
      process.env.PATH = originalPath
      process.env.HOME = originalHome
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
