import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'

export function opencodeTaskKey(taskId: string): string {
  return createHash('sha256').update(taskId).digest('hex')
}

export function opencodeTaskDirectory(controllerHome: string, taskKey: string): string {
  if (!/^[a-f0-9]{64}$/.test(taskKey))
    throw new Error('The OpenCode Task key is invalid.')
  return join(controllerHome, '.local/share/harlan-github-agent/opencode-tasks', taskKey)
}

/** Workers receive only the child mount. They cannot rename its controller-owned parents. */
export async function prepareOpencodeTaskDirectory(controllerHome: string, taskKey: string): Promise<string> {
  opencodeTaskDirectory(controllerHome, taskKey)
  let parent = await open(controllerHome, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    for (const component of ['.local', 'share', 'harlan-github-agent', 'opencode-tasks', taskKey]) {
      const path = `/proc/self/fd/${parent.fd}/${component}`
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST')
          throw error
      })
      const child = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      await parent.close()
      parent = child
    }
    return await realpath(`/proc/self/fd/${parent.fd}`)
  }
  finally {
    await parent.close()
  }
}
