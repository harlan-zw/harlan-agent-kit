import { access } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { desktopCommand } from './desktop-worktree.ts'

async function helper(): Promise<string> {
  const candidates = [join(process.cwd(), 'harlan-agent-kit/scripts/worktree-claim.sh'), fileURLToPath(new URL('../../../harlan-agent-kit/scripts/worktree-claim.sh', import.meta.url))]
  for (const path of candidates) {
    const exists = await access(path).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        return false
      throw error
    })
    if (exists)
      return path
  }
  throw new Error('The Worktree claim helper is unavailable.')
}
export async function acquireDesktopSessionClaim(workspace: string, sessionId: string): Promise<void> {
  const result = JSON.parse(await desktopCommand('bash', [await helper(), 'acquire', '--path', workspace, '--session', sessionId], workspace)) as { claimed: boolean }
  if (!result.claimed)
    throw new Error('Another Agent owns this Worktree.')
}
export async function releaseDesktopSessionClaim(workspace: string, sessionId: string): Promise<void> {
  await desktopCommand('bash', [await helper(), 'release', '--path', workspace, '--session', sessionId], workspace)
}
