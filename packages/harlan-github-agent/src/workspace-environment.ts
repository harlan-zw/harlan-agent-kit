import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Names a repository file must never set for an Agent process.
 *
 * A seeded `.env` carries the tokens a repository's own tooling reads. It is
 * not a place to change which binaries run, how shells start (BASH_ENV, ENV),
 * or how Node starts, and a checkout that commits one of these could otherwise
 * steer the controller's child process. Everything else passes through as the
 * repository wrote it.
 */
const REFUSED_NAMES = new Set([
  'BASH_ENV',
  'ENV',
  'HOME',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'PNPM_HOME',
  'SHELL',
  'USER',
])

const REFUSED_PREFIXES = ['DYLD_', 'GIT_', 'LD_', 'OPENCODE_', 'CODEX_']

/** Reads a `.env` file, the way the repository's tooling would. */
export function parseEnvironmentFile(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#'))
      continue
    const separator = line.indexOf('=')
    if (separator < 1)
      continue
    const name = line.slice(0, separator).replace(/^export\s+/, '').trim()
    if (!/^[A-Z_][\w.-]*$/i.test(name))
      continue
    const rawValue = line.slice(separator + 1).trim()
    let value = rawValue
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith('\'') && value.endsWith('\'') && value.length >= 2)) {
      value = value.slice(1, -1)
      if (rawValue.startsWith('"'))
        value = value.replaceAll('\\n', '\n')
    }
    else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    if (REFUSED_NAMES.has(name) || REFUSED_PREFIXES.some(prefix => name.startsWith(prefix)))
      continue
    values[name] = value
  }
  return values
}

/**
 * The environment one Agent turn runs with, given its worktree.
 *
 * Worktrunk seeds each repository's `.env` into the worktree from the trusted
 * copy in the primary checkout. The check-in scripts read their Cloudflare,
 * Sentry, and NuxtSEO tokens from the process environment, so the turn loads
 * that file the way a person's shell would before running the same command.
 * The repository's values win over the service's own, because they are that
 * repository's configuration and the service has no better answer.
 *
 * Answers the same object when the worktree has no `.env`, so a provider that
 * shares one environment across turns keeps sharing it.
 */
export function workspaceEnvironment(base: NodeJS.ProcessEnv, workspace: string): NodeJS.ProcessEnv {
  const path = join(workspace, '.env')
  if (!existsSync(path))
    return base
  const values = parseEnvironmentFile(readFileSync(path, 'utf8'))
  return Object.keys(values).length === 0 ? base : { ...base, ...values }
}
