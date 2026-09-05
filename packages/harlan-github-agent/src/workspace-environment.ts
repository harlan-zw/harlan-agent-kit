import { readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Names a repository file must never set for an Agent process.
 *
 * A seeded `.env` carries the tokens a repository's own tooling reads. It is
 * not a place to change which binaries run, how shells start (BASH_ENV, ENV),
 * how Node starts, where child processes send their traffic (proxies,
 * certificate trust, provider endpoints), or which config directories the
 * Agent's tools read. Everything else passes through as the repository wrote
 * it.
 */
const REFUSED_NAMES = new Set([
  'ALL_PROXY',
  'BASH_ENV',
  'CURL_CA_BUNDLE',
  'ENV',
  'GH_CONFIG_DIR',
  'GITHUB_API_URL',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'PNPM_HOME',
  'REQUESTS_CA_BUNDLE',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'USER',
  'XDG_CONFIG_HOME',
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
    const upperName = name.toUpperCase()
    if (REFUSED_NAMES.has(upperName) || REFUSED_PREFIXES.some(prefix => upperName.startsWith(prefix)))
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
 * Answers the same object when the worktree has no `.env` and no binaries, so
 * a provider that shares one environment across turns keeps sharing it. A `.env` path that is
 * unreadable or not a regular file (a tracked `.env/` directory, for example)
 * falls back to the base environment rather than failing the turn.
 */
function readEnvironmentValues(path: string): Record<string, string> {
  try {
    return statSync(path).isFile() ? parseEnvironmentFile(readFileSync(path, 'utf8')) : {}
  }
  catch {
    // An unreadable .env is the same as none: the turn still runs.
    return {}
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  }
  catch {
    return false
  }
}

export function workspaceEnvironment(base: NodeJS.ProcessEnv, workspace: string): NodeJS.ProcessEnv {
  const values = readEnvironmentValues(join(workspace, '.env'))
  // A repository's own binaries come first, the way a shell inside it would
  // find them. The service unit carries a bare PATH, so a check-in script that
  // shelled out to `wrangler` found nothing and reported every probe as failed.
  const binaries = join(workspace, 'node_modules', '.bin')
  const PATH = isDirectory(binaries)
    ? [binaries, base.PATH].filter(entry => entry !== undefined && entry !== '').join(delimiter)
    : base.PATH
  if (Object.keys(values).length === 0 && PATH === base.PATH)
    return base
  return { ...base, ...values, ...(PATH === undefined ? {} : { PATH }) }
}
