import type { Dirent } from 'node:fs'
import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export type ReviewStaticRead = { _tag: 'Read', text: string, truncated: boolean, nextOffset?: number } | { _tag: 'Refused', reason: string }
export type ReviewStaticSearch = { _tag: 'Matches', matches: { path: string, line: number, text: string }[], truncated: boolean } | { _tag: 'Refused', reason: string }
const maximumFileBytes = 16_000
const maximumFiles = 400
const maximumMatches = 60
const maximumEntries = 4000

function contained(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`)
}

/** Run this reader inside the worker namespace. It never reads controller paths. */
export function createReviewStaticReader(workspace: string): { read: (path: unknown, offset?: unknown) => Promise<ReviewStaticRead>, search: (text: unknown) => Promise<ReviewStaticSearch> } {
  const root = resolve(workspace)
  const read = async (input: unknown, offset: unknown = 0): Promise<ReviewStaticRead> => {
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 32_000_000)
      return { _tag: 'Refused', reason: 'The read offset must be between 0 and 32000000 bytes.' }
    if (typeof input !== 'string' || input.length > 500 || isAbsolute(input))
      return { _tag: 'Refused', reason: 'Use a relative file path inside the Review worktree.' }
    const path = resolve(root, input)
    if (!contained(path, root))
      return { _tag: 'Refused', reason: 'The file path leaves the Review worktree.' }
    // Reject every symlink component. Recheck the opened descriptor before reading to close directory replacement races.
    let component = root
    for (const part of relative(root, path).split(sep)) {
      component = join(component, part)
      const metadata = await lstat(component).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT')
          return null
        throw error
      })
      if (metadata === null || metadata.isSymbolicLink() || (component === path && !metadata.isFile()))
        return { _tag: 'Refused', reason: 'The file is missing or uses a symlink.' }
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
      if (['ENOENT', 'ELOOP', 'EISDIR'].includes(error.code ?? ''))
        return null
      throw error
    })
    if (file === null)
      return { _tag: 'Refused', reason: 'The file is missing or uses a symlink.' }
    try {
      const openedPath = await realpath(`/proc/self/fd/${file.fd}`)
      if (!contained(openedPath, root) || !(await file.stat()).isFile())
        return { _tag: 'Refused', reason: 'The opened file leaves the Review worktree.' }
      const bytes = Buffer.alloc(maximumFileBytes + 1)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, Number(offset))
      let end = Math.min(bytesRead, maximumFileBytes)
      while (end > 0 && end < bytesRead && (bytes[end]! & 0xC0) === 0x80)
        end--
      return { _tag: 'Read', text: bytes.subarray(0, end).toString('utf8'), truncated: bytesRead > end, ...(bytesRead > end ? { nextOffset: Number(offset) + end } : {}) }
    }
    finally {
      await file.close()
    }
  }
  return {
    read,
    async search(input) {
      if (typeof input !== 'string' || input.length === 0 || input.length > 200)
        return { _tag: 'Refused', reason: 'Search requires 1 to 200 literal characters.' }
      const directories = ['']
      const matches: { path: string, line: number, text: string }[] = []
      let files = 0
      let visitedDirectories = 0
      let visitedEntries = 0
      let truncated = false
      while (directories.length > 0 && visitedDirectories++ < maximumFiles && visitedEntries < maximumEntries && files < maximumFiles && matches.length < maximumMatches) {
        const directory = directories.shift()!
        const directoryHandle = await open(join(root, directory), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
          if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code ?? ''))
            return null
          throw error
        })
        if (directoryHandle === null) {
          truncated = true
          continue
        }
        const entries = await (async () => {
          try {
            const descriptorPath = `/proc/self/fd/${directoryHandle.fd}`
            if (!contained(await realpath(descriptorPath), root))
              return null
            const entries: Dirent[] = []
            const cursor = await opendir(descriptorPath, { bufferSize: 32 })
            for await (const entry of cursor) {
              if (visitedEntries++ >= maximumEntries) {
                truncated = true
                break
              }
              entries.push(entry)
            }
            return entries
          }
          finally {
            await directoryHandle.close()
          }
        })()
        if (entries === null)
          return { _tag: 'Refused', reason: 'The search directory leaves the Review worktree.' }
        for (const entry of entries) {
          if (entry.name === '.git' || entry.name === 'node_modules' || entry.isSymbolicLink())
            continue
          const path = join(directory, entry.name)
          if (entry.isDirectory()) {
            if (directories.length < maximumFiles)
              directories.push(path)
            else
              truncated = true
            continue
          }
          if (!entry.isFile())
            continue
          if (++files > maximumFiles || matches.length >= maximumMatches) {
            truncated = true
            break
          }
          const result = await read(path)
          if (result._tag === 'Refused')
            continue
          truncated ||= result.truncated
          const lines = result.text.split('\n')
          for (let index = 0; index < lines.length && matches.length < maximumMatches; index++) {
            if (lines[index]!.includes(input))
              matches.push({ path, line: index + 1, text: lines[index]!.slice(0, 300) })
          }
        }
      }
      return { _tag: 'Matches', matches, truncated: truncated || directories.length > 0 || matches.length >= maximumMatches }
    },
  }
}
