import { constants } from 'node:fs'
import { access, open, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'

export const workerToolNames = ['gh', 'bun', 'wt', 'rg', 'fd', 'codex', 'opencode'] as const

/** Only controller-owned installation directories may supply Agent executables. */
export async function resolveWorkerHostTools(
  home: string,
  directories: readonly string[],
): Promise<Record<string, string>> {
  const tools: Record<string, string> = {}
  const trusted = [
    ...new Set([
      join(home, '.local/share/wolfstar-agent-kit/tools/bin'),
      join(home, '.local/bin'),
      join(home, '.local/share/pnpm'),
      join(home, '.bun/bin'),
      join(home, '.cargo/bin'),
      join(home, '.opencode/bin'),
      ...directories,
    ]),
  ]
  for (const name of workerToolNames) {
    for (const directory of trusted) {
      const path = join(directory, name)
      const available = await access(path, constants.X_OK)
        .then(() => true)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES') return false
          throw error
        })
      if (!available) continue
      let binary = await realpath(path)
      if (name === 'codex') {
        // pnpm's shell shim points at JavaScript. The namespace needs the native executable.
        const file = await open(binary, 'r')
        const shim = await file
          .read({ buffer: Buffer.alloc(65536) })
          .then((result) => result.buffer.subarray(0, result.bytesRead))
          .finally(() => file.close())
        if (shim.subarray(0, 2).toString() === '#!') {
          const target = /^# cmd-shim-target=(\/[^\r\n]+)$/m.exec(shim.toString())?.[1]
          if (target === undefined) continue
          const platform = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`
          const packageRoot = dirname(dirname(target))
          const candidates = [
            join(packageRoot, 'vendor', platform, 'bin/codex'),
            join(packageRoot, 'vendor', platform, 'codex/codex'),
            join(packageRoot, '..', `codex-linux-${process.arch}`, 'vendor', platform, 'codex/codex'),
          ]
          let native: string | undefined
          for (const candidate of candidates) {
            if (
              await access(candidate, constants.X_OK)
                .then(() => true)
                .catch((error: NodeJS.ErrnoException) => {
                  if (error.code === 'ENOENT') return false
                  throw error
                })
            ) {
              native = await realpath(candidate)
              break
            }
          }
          if (native === undefined) throw new Error(`The installed Codex native executable is missing: ${target}`)
          binary = native
        }
        const host = join(dirname(binary), 'codex-code-mode-host')
        await access(host, constants.X_OK).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES')
            throw new Error(`The installed Codex command host is missing: ${host}`)
          throw error
        })
        tools['codex-code-mode-host'] = await realpath(host)
      }
      tools[name] = binary
      break
    }
  }
  return tools
}
