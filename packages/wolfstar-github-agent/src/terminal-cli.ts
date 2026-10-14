import type { TerminalProject, TerminalProvider } from './terminal-protocol.ts'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createTerminalControllerObserver,
  parseTerminalControllerObserverConfig,
} from './terminal-controller-observer.ts'
import { createTerminalDiffRequests } from './terminal-controller.ts'
import { createTerminalRuntime } from './terminal-runtime.ts'

export interface TerminalLocalConfig {
  directory: string
  origin: string
  hostLabel: string
  projects: TerminalProject[]
  providers: Record<TerminalProvider, { executable: string; argv: string[] }>
  helperSource: string
  admissionCli: string
  claimScript: string
  staticDirectory: string
  memoryGiB: number
  protectedPaths?: string[]
  controller?: { origin: string; passwordFile: string }
}
export function parseTerminalLocalConfig(value: unknown): TerminalLocalConfig {
  if (typeof value !== 'object' || value === null) throw new Error('Terminal configuration must be an object')
  const input = value as Record<string, unknown>
  for (const key of ['directory', 'helperSource', 'admissionCli', 'claimScript', 'staticDirectory']) {
    if (typeof input[key] !== 'string' || !isAbsolute(input[key]) || input[key].includes('\0')) {
      throw new Error(`Terminal ${key} must be an absolute path`)
    }
  }
  if (typeof input.origin !== 'string') throw new Error('Terminal origin is required')
  const origin = new URL(input.origin)
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    !origin.port ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error('Standalone terminal requires an exact loopback origin')
  }
  if (!Number.isSafeInteger(input.memoryGiB) || Number(input.memoryGiB) < 1 || Number(input.memoryGiB) > 64) {
    throw new Error('Terminal memory must be between 1 and 64 GiB')
  }
  if (!Array.isArray(input.projects) || input.projects.length > 1000) throw new Error('Terminal Projects are required')
  const projects = input.projects.map((value): TerminalProject => {
    if (typeof value !== 'object' || value === null) throw new Error('Invalid terminal Project')
    const project = value as Record<string, unknown>
    if (
      typeof project.id !== 'string' ||
      !/^[\w.-]{1,128}$/.test(project.id) ||
      typeof project.name !== 'string' ||
      !project.name ||
      typeof project.path !== 'string' ||
      !isAbsolute(project.path) ||
      project.path.includes('\0')
    ) {
      throw new Error('Invalid terminal Project')
    }
    return { id: project.id, name: project.name, path: project.path }
  })
  if (new Set(projects.map((project) => project.id)).size !== projects.length)
    throw new Error('Terminal Project IDs must be unique')
  if (typeof input.providers !== 'object' || input.providers === null)
    throw new Error('Terminal providers are required')
  const providers = {} as TerminalLocalConfig['providers']
  for (const provider of ['codex', 'claude', 'opencode'] as const) {
    const config = (input.providers as Record<string, unknown>)[provider]
    if (typeof config !== 'object' || config === null) throw new Error(`Terminal ${provider} is required`)
    const values = config as Record<string, unknown>
    if (
      typeof values.executable !== 'string' ||
      !isAbsolute(values.executable) ||
      values.executable.includes('\0') ||
      !Array.isArray(values.argv) ||
      values.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    ) {
      throw new Error(`Terminal ${provider} is invalid`)
    }
    providers[provider] = {
      executable: values.executable,
      argv: values.argv as string[],
    }
  }
  if (
    input.protectedPaths !== undefined &&
    (!Array.isArray(input.protectedPaths) ||
      input.protectedPaths.length > 100 ||
      !input.protectedPaths.every((path) => typeof path === 'string' && isAbsolute(path) && !path.includes('\0')))
  ) {
    throw new Error('Terminal protected paths must be absolute paths')
  }
  const controller =
    input.controller === undefined ? undefined : parseTerminalControllerObserverConfig(input.controller)
  if (controller?._tag === 'Err') throw new Error('Invalid terminal controller configuration')
  return {
    directory: input.directory as string,
    origin: origin.origin,
    hostLabel: typeof input.hostLabel === 'string' ? input.hostLabel : hostname(),
    projects,
    providers,
    helperSource: input.helperSource as string,
    admissionCli: input.admissionCli as string,
    claimScript: input.claimScript as string,
    staticDirectory: input.staticDirectory as string,
    memoryGiB: Number(input.memoryGiB),
    ...(input.protectedPaths ? { protectedPaths: input.protectedPaths as string[] } : {}),
    ...(controller?._tag === 'Ok' ? { controller: controller.value } : {}),
  }
}
export async function serveLocalTerminals(config: TerminalLocalConfig) {
  const observer = config.controller
    ? createTerminalControllerObserver({
        origin: config.controller.origin,
        password: (await readFile(config.controller.passwordFile, 'utf8')).trim(),
        log: (message, cause) => console.error(message, cause instanceof Error ? cause.message : String(cause)),
      })
    : undefined
  const runtime = await createTerminalRuntime({
    ...config,
    controller: Boolean(observer),
    controllerReadOnly: Boolean(observer),
    observer,
    diff: createTerminalDiffRequests(Date.now),
    protectedPaths: [...(config.protectedPaths ?? []), ...(config.controller ? [config.controller.passwordFile] : [])],
  })
  const api = runtime.routes
  await new Promise<void>((resolve) => api.server.listen(Number(new URL(config.origin).port), '127.0.0.1', resolve))
  process.stdout.write(`Open local terminal Projects: ${api.pairingUrl}\n`)
  return { ...runtime, api }
}
async function main() {
  const configPath = process.argv[2]
  if (configPath === '--help' || configPath === '-h') {
    process.stdout.write(
      'Usage: wolfstar-terminal <configuration.json>\n\nOpen Projects and Agent terminals in your browser.\nUse the pairing link printed at startup.\nClose this command to disconnect. Running Agents remain alive.\nStop an Agent through the terminal UI.\n',
    )
    return
  }
  if (!configPath) throw new Error('Pass the local terminal configuration path')
  const service = await serveLocalTerminals(parseTerminalLocalConfig(JSON.parse(await readFile(configPath, 'utf8'))))
  process.once('SIGTERM', () => {
    void service.close()
  })
  process.once('SIGINT', () => {
    void service.close()
  })
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  })
}
