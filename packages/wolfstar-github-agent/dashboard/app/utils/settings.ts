/**
 * Settings the Cloudflare edge Worker holds for the controller.
 *
 * The Worker keeps the provider logins and answers this contract under
 * `/setup/api`. It never sends a secret back, only whether one is set.
 * Keep in step with `SettingsView` in
 * `packages/wolfstar-github-edge/src/settings.ts`.
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

/** What a save sends. A string sets a value, `null` removes it, a missing key keeps it. */
export interface SettingsChanges {
  claudeToken?: string | null
  codexAuth?: string | null
  zaiApiKey?: string | null
  workersAiToken?: string | null
  workersAiAccountId?: string | null
  githubUserToken?: string | null
  mutationsEnabled?: boolean
}

export type ProviderId = 'claude' | 'codex' | 'opencode' | 'workersAi'

export interface ProviderField {
  /** The key this field fills in `SettingsChanges`. */
  key: Exclude<keyof SettingsChanges, 'mutationsEnabled'>
  label: string
  hint: string
  /** A login is long and multi line, so it takes a text area. */
  multiline?: boolean
  optional?: boolean
}

export interface ProviderDescription {
  id: ProviderId
  title: string
  summary: string
  /** Where the person gets the login. */
  source: string
  fields: ProviderField[]
}

/** Every Agent provider the Settings page can configure, in the order the page lists them. */
export const PROVIDERS: readonly ProviderDescription[] = [
  {
    id: 'claude',
    title: 'Claude',
    summary: 'Runs on your Claude subscription.',
    source: 'Run `claude setup-token` on your computer and paste what it prints.',
    fields: [{ key: 'claudeToken', label: 'Token', hint: 'Starts with sk-ant-oat01-' }],
  },
  {
    id: 'codex',
    title: 'Codex',
    summary: 'Runs on your ChatGPT subscription.',
    source: 'Run `codex login`, then paste the whole contents of ~/.codex/auth.json.',
    fields: [{ key: 'codexAuth', label: 'auth.json', hint: 'The whole file, as JSON', multiline: true }],
  },
  {
    id: 'opencode',
    title: 'opencode on the GLM Coding Plan',
    summary: 'Runs GLM models on the GLM Coding Plan.',
    source: 'Copy the API key from your GLM Coding Plan account.',
    fields: [{ key: 'zaiApiKey', label: 'API key', hint: 'The GLM Coding Plan key' }],
  },
  {
    id: 'workersAi',
    title: 'Cloudflare Workers AI',
    summary: 'Runs open models through opencode, billed per token to your Cloudflare account.',
    source: 'Create an API token with the Workers AI Read permission.',
    fields: [
      { key: 'workersAiToken', label: 'API token', hint: 'Needs Workers AI Read' },
      {
        key: 'workersAiAccountId',
        label: 'Account ID',
        hint: 'Leave it empty when the token sees one account',
        optional: true,
      },
    ],
  },
] as const

export function isProviderConfigured(view: SettingsView, id: ProviderId): boolean {
  return view.providers[id].configured
}

export function configuredProviderCount(view: SettingsView): number {
  return PROVIDERS.filter((provider) => isProviderConfigured(view, provider.id)).length
}

/**
 * The last provider cannot be removed, because the controller could not
 * start without one. The Worker refuses it too. The page just does not offer it.
 */
export function canRemoveProvider(view: SettingsView, id: ProviderId): boolean {
  return isProviderConfigured(view, id) && configuredProviderCount(view) > 1
}

/** The keys a provider's fields hold, so removing it clears every one. */
export function providerKeys(id: ProviderId): ProviderField['key'][] {
  return PROVIDERS.find((provider) => provider.id === id)!.fields.map((field) => field.key)
}

/** Reads a pasted Codex login. The Worker checks it too, but a typo should not cost a round trip. */
export function codexLoginProblem(text: string): string | null {
  if (text.trim() === '') return null
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? null
      : 'That is JSON, but not the contents of auth.json.'
  } catch {
    return 'That is not JSON. Paste the whole auth.json file.'
  }
}

/** The body for saving one provider: only the fields the person filled in. */
export function saveChanges(id: ProviderId, drafts: Partial<Record<ProviderField['key'], string>>): SettingsChanges {
  const changes: SettingsChanges = {}
  for (const key of providerKeys(id)) {
    const value = drafts[key]?.trim()
    if (value !== undefined && value !== '') changes[key] = value
  }
  return changes
}

/** The body for removing one provider: every one of its fields set to null. */
export function removeChanges(id: ProviderId): SettingsChanges {
  const changes: SettingsChanges = {}
  for (const key of providerKeys(id)) changes[key] = null
  return changes
}

export type SettingsAvailability =
  | { _tag: 'Loading' }
  | { _tag: 'Available'; view: SettingsView }
  | { _tag: 'SignedOut' }
  /** The Service runs from a configuration file, not from the Cloudflare edge Worker. */
  | { _tag: 'Unmanaged' }
  | { _tag: 'Failed'; reason: string }

/** Turns a failed load into what the page should say, by the status the request got. */
export function availabilityFromError(status: number | undefined, reason: string): SettingsAvailability {
  if (status === 401 || status === 403) return { _tag: 'SignedOut' }
  if (status === 404) return { _tag: 'Unmanaged' }
  return { _tag: 'Failed', reason }
}
