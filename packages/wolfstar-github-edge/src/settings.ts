import type { SetupDependencies, SetupRecord } from './setup.ts'

/**
 * Provider settings, shared by the first-run form and the dashboard.
 *
 * One function applies a change and checks it, so the form and the Settings
 * page cannot disagree about what a valid login is. The Worker holds the
 * secrets. A view of them leaves this module with only what is configured,
 * never the value.
 */

export const USER_AGENT = 'wolfstar-github-edge'

/**
 * What a caller wants changed.
 *
 * `undefined` keeps the saved value, `null` removes it, and a string sets it.
 */
export interface ProviderChanges {
  claudeToken?: string | null | undefined
  codexAuth?: string | null | undefined
  zaiApiKey?: string | null | undefined
  workersAiToken?: string | null | undefined
  workersAiAccountId?: string | null | undefined
  githubUserToken?: string | null | undefined
  mutationsEnabled?: boolean | undefined
}

export type ChangeOutcome =
  | { _tag: 'Applied'; record: SetupRecord; forgetCodexLogin: boolean }
  | { _tag: 'Refused'; status: number; title: string; message: string }

/**
 * The saved settings, without a single secret.
 *
 * Keep in step with `SettingsView` in
 * `packages/wolfstar-github-agent/dashboard/app/utils/settings.ts`.
 */
export interface SettingsView {
  ready: boolean
  app: { slug: string; owner: string; htmlUrl: string; installUrl: string } | null
  providers: {
    claude: { configured: boolean }
    codex: { configured: boolean }
    opencode: { configured: boolean }
    workersAi: { configured: boolean; accountId: string | null }
  }
  githubUser: { login: string } | null
  mutationsEnabled: boolean
}

export function settingsView(record: SetupRecord, ready: boolean): SettingsView {
  const { claudeToken, codexAuth, zaiApiKey, workersAiToken, workersAiAccountId } = record.providers
  return {
    ready,
    app:
      record.app === null
        ? null
        : {
            slug: record.app.slug,
            owner: record.app.owner,
            htmlUrl: record.app.htmlUrl,
            installUrl: `${record.app.htmlUrl}/installations/new`,
          },
    providers: {
      claude: { configured: claudeToken !== null },
      codex: { configured: codexAuth !== null },
      opencode: { configured: zaiApiKey !== null },
      workersAi: { configured: workersAiToken !== null, accountId: workersAiAccountId },
    },
    githubUser: record.githubUser === null ? null : { login: record.githubUser.login },
    mutationsEnabled: record.mutationsEnabled,
  }
}

const SECRET_FIELDS = [
  'claudeToken',
  'codexAuth',
  'zaiApiKey',
  'workersAiToken',
  'workersAiAccountId',
  'githubUserToken',
] as const

const MAXIMUM_LENGTH = { codexAuth: 20_000, default: 4_096 } as const

/** Reads a JSON body into changes, or says what is wrong with it. */
export function parseProviderChanges(
  body: unknown,
): { _tag: 'Ok'; changes: ProviderChanges } | { _tag: 'Err'; message: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return { _tag: 'Err', message: 'Send a JSON object with the settings to change.' }
  const input = body as Record<string, unknown>
  const known = new Set<string>([...SECRET_FIELDS, 'mutationsEnabled'])
  const unknown = Object.keys(input).find((key) => !known.has(key))
  if (unknown !== undefined) return { _tag: 'Err', message: `Unknown setting: ${unknown}.` }

  const changes: ProviderChanges = {}
  for (const field of SECRET_FIELDS) {
    const value = input[field]
    if (value === undefined) continue
    if (value === null) {
      changes[field] = null
      continue
    }
    if (typeof value !== 'string') return { _tag: 'Err', message: `${field} must be a string, or null to remove it.` }
    const trimmed = value.trim()
    // An empty field means "leave it", the way an empty form field does.
    if (trimmed === '') continue
    const limit = field === 'codexAuth' ? MAXIMUM_LENGTH.codexAuth : MAXIMUM_LENGTH.default
    if (trimmed.length > limit) return { _tag: 'Err', message: `${field} is longer than ${limit} characters.` }
    changes[field] = trimmed
  }
  if (input.mutationsEnabled !== undefined) {
    if (typeof input.mutationsEnabled !== 'boolean')
      return { _tag: 'Err', message: 'mutationsEnabled must be true or false.' }
    changes.mutationsEnabled = input.mutationsEnabled
  }
  return { _tag: 'Ok', changes }
}

type WorkersAiCheck = { _tag: 'Accepted'; accountId: string } | { _tag: 'Refused'; reason: string }

/**
 * Finds the account a Workers AI token bills and proves the token can reach Workers AI.
 *
 * A wrong token fails here, on the page that took it, instead of on the first Agent turn.
 */
export async function checkWorkersAi(
  dependencies: Pick<SetupDependencies, 'fetch'>,
  token: string,
  typedAccount: string | null,
): Promise<WorkersAiCheck> {
  const call = async (path: string): Promise<{ ok: boolean; body: { result?: unknown } }> => {
    const response = await dependencies.fetch(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { authorization: `Bearer ${token}`, 'user-agent': USER_AGENT },
    })
    return { ok: response.ok, body: (await response.json().catch(() => ({}))) as { result?: unknown } }
  }

  let accountId = typedAccount
  if (accountId !== null && !/^[0-9a-f]{32}$/.test(accountId))
    return { _tag: 'Refused', reason: 'The account ID must have 32 hexadecimal characters.' }
  if (accountId === null) {
    const accounts = await call('/accounts?per_page=50')
    const ids = Array.isArray(accounts.body.result)
      ? accounts.body.result.flatMap((account: { id?: unknown }) =>
          typeof account.id === 'string' ? [account.id] : [],
        )
      : []
    if (!accounts.ok || ids.length === 0)
      return { _tag: 'Refused', reason: 'The token cannot list any account. Enter the account ID as well.' }
    if (ids.length > 1)
      return { _tag: 'Refused', reason: 'The token can see more than one account. Enter the account ID as well.' }
    accountId = ids[0]!
  }
  const models = await call(`/accounts/${accountId}/ai/models/search?per_page=1`)
  if (!models.ok)
    return { _tag: 'Refused', reason: 'The token cannot read Workers AI on that account. Give it Workers AI Read.' }
  return { _tag: 'Accepted', accountId }
}

function hasAnyProvider(providers: SetupRecord['providers']): boolean {
  return (providers.claudeToken ?? providers.codexAuth ?? providers.zaiApiKey ?? providers.workersAiToken) !== null
}

/**
 * Applies one change and checks every login it touches.
 *
 * Nothing is written here. The caller saves the record and restarts the
 * controller, so a refusal leaves the saved settings exactly as they were.
 */
export async function applyProviderChanges(
  record: SetupRecord,
  changes: ProviderChanges,
  dependencies: Pick<SetupDependencies, 'fetch'>,
): Promise<ChangeOutcome> {
  const refused = (status: number, title: string, message: string): ChangeOutcome => ({
    _tag: 'Refused',
    status,
    title,
    message,
  })

  if (typeof changes.codexAuth === 'string') {
    try {
      JSON.parse(changes.codexAuth)
    } catch {
      return refused(400, 'Codex login is not JSON', 'Paste the whole ~/.codex/auth.json.')
    }
  }

  let workersAiToken = record.providers.workersAiToken
  let workersAiAccountId = record.providers.workersAiAccountId
  if (changes.workersAiToken === null) {
    // The account ID means nothing without its token.
    workersAiToken = null
    workersAiAccountId = null
  } else {
    const typedAccount = typeof changes.workersAiAccountId === 'string' ? changes.workersAiAccountId : null
    if (typeof changes.workersAiToken === 'string') workersAiToken = changes.workersAiToken
    if (typedAccount !== null) workersAiAccountId = typedAccount
    if (workersAiToken !== null && (typeof changes.workersAiToken === 'string' || typedAccount !== null)) {
      const account = await checkWorkersAi(dependencies, workersAiToken, typedAccount)
      if (account._tag === 'Refused') return refused(400, 'Workers AI login refused', account.reason)
      workersAiAccountId = account.accountId
    }
  }

  let githubUser = record.githubUser
  if (changes.githubUserToken === null) {
    githubUser = null
  } else if (typeof changes.githubUserToken === 'string') {
    const token = changes.githubUserToken
    const user = await dependencies
      .fetch('https://api.github.com/user', {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
      })
      .then(async (response) => (response.ok ? ((await response.json()) as { login?: unknown }) : null))
      .catch(() => null)
    if (typeof user?.login !== 'string')
      return refused(400, 'GitHub token refused', 'GitHub did not accept the maintainer token.')
    githubUser = { token, login: user.login }
  }

  const keep = <T>(change: T | null | undefined, saved: T | null): T | null =>
    change === null ? null : (change ?? saved)
  const next: SetupRecord = {
    ...record,
    githubUser,
    providers: {
      claudeToken: keep(changes.claudeToken, record.providers.claudeToken),
      codexAuth: keep(changes.codexAuth, record.providers.codexAuth),
      zaiApiKey: keep(changes.zaiApiKey, record.providers.zaiApiKey),
      workersAiToken,
      workersAiAccountId,
    },
    mutationsEnabled: changes.mutationsEnabled ?? record.mutationsEnabled,
  }

  // A controller with no Agent provider cannot start, so removing the last one is refused.
  if (hasAnyProvider(record.providers) && !hasAnyProvider(next.providers))
    return refused(400, 'Keep one Agent provider', 'The controller needs at least one Agent provider to start.')

  return { _tag: 'Applied', record: next, forgetCodexLogin: changes.codexAuth !== undefined }
}
