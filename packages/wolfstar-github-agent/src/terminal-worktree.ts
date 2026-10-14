import type { TerminalProject } from './terminal-protocol.ts'
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export function createTerminalWorktreeAdapter(claimScript: string, run: typeof execute = execute) {
  if (!isAbsolute(claimScript)) throw new Error('Worktree claim path must be absolute')
  const preparing = new Map<string, Promise<string>>()
  async function find(project: TerminalProject, branch: string) {
    const { stdout } = await run('wt', ['list', '--format=json'], {
      cwd: project.path,
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    })
    const list = JSON.parse(stdout) as {
      items: { branch: string; worktree?: { path: string } }[]
    }
    const path = list.items.find((item) => item.branch === branch)?.worktree?.path
    if (!path) return null
    return realpath(path)
  }
  async function claim(action: 'acquire' | 'release', sessionId: string, path: string) {
    await run(
      'bash',
      [
        claimScript,
        action,
        '--path',
        path,
        '--session',
        `terminal-${sessionId}`,
        ...(action === 'acquire' ? ['--durable'] : []),
      ],
      { timeout: 10000 },
    )
  }
  return {
    recoverWorktree: (project: TerminalProject, sessionId: string) => find(project, `terminal/${sessionId}`),
    prepare(project: TerminalProject, sessionId: string) {
      const task = async () => {
        if (!/^[a-f\d]{24}$/.test(sessionId)) throw new Error('Invalid terminal session identity')
        const branch = `terminal/${sessionId}`
        let path = await find(project, branch)
        if (!path) {
          await run('wt', ['switch', '--create', branch, '--base', 'origin/main'], {
            cwd: project.path,
            timeout: 240000,
            maxBuffer: 4 * 1024 * 1024,
          })
          path = await find(project, branch)
        }
        if (!path || path === (await realpath(project.path))) throw new Error('Terminal requires a task-owned Worktree')
        await claim('acquire', sessionId, path)
        return path
      }
      const previous = preparing.get(project.id)
      // Each caller receives its own failure. A failed preparation does not prevent the next independent request.
      const next = previous ? previous.then(task, task) : task()
      preparing.set(project.id, next)
      return next
    },
    releaseWorktree: (sessionId: string, path: string) => claim('release', sessionId, path),
    renewWorktree: (sessionId: string, path: string) => claim('acquire', sessionId, path),
  }
}
