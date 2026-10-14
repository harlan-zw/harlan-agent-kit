import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { PRODUCTION_D1_REPOSITORIES } from './d1-query-scope.ts'
import { parseEnvironmentFile } from './workspace-environment.ts'

/** Read only the scheduled repository's private check-in values before entering its isolated home. */
export async function checkinEnvironment(input: {
  controllerHome: string
  repository: string | undefined
  taskId: string | undefined
}): Promise<Record<string, string>> {
  const routine = /^([a-z0-9][a-z0-9-]*\/([a-z0-9][\w.-]*)):(daily-checkin|d1-query-review):/i.exec(input.taskId ?? '')
  if (routine === null) return {}
  if (routine[1]!.toLowerCase() !== input.repository?.toLowerCase())
    throw new Error('The daily check-in repository does not match its Worktree origin.')
  const fleet =
    routine[3]?.toLowerCase() === 'd1-query-review' && PRODUCTION_D1_REPOSITORIES.has(routine[1]!.toLowerCase())
  const path = join(input.controllerHome, '.config/wolfstar-checkin', `${fleet ? 'd1-query-review' : routine[2]}.env`)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
    (error: NodeJS.ErrnoException) => {
      // Missing credentials remain a coverage gap for the collector to report.
      if (error.code === 'ENOENT') return undefined
      throw error
    },
  )
  if (file === undefined) return { CI: 'true' }
  try {
    const metadata = await file.stat()
    const canonical = await realpath(`/proc/self/fd/${file.fd}`)
    if (
      canonical !== path ||
      !metadata.isFile() ||
      metadata.size > 64 * 1024 ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.uid !== process.getuid?.()
    ) {
      throw new Error('The daily check-in credential file must be private, bounded, and owned by this account.')
    }
    const values = parseEnvironmentFile(await file.readFile('utf8'))
    // A private file may carry collection values, never change worker setup or archive ownership.
    delete values.DAILY_CHECKIN_DIR
    delete values.XDG_DATA_HOME
    delete values.XDG_STATE_HOME
    const collection = fleet
      ? Object.fromEntries(
          Object.entries(values).filter(([name]) => ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].includes(name)),
        )
      : values
    return { ...collection, CI: 'true' }
  } finally {
    await file.close()
  }
}
