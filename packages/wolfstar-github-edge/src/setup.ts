/**
 * First-run setup, so a deploy needs no configuration file.
 *
 * The GitHub App manifest flow creates the App with the permissions and
 * events the controller needs, and GitHub hands back its key and webhook
 * secret. The person creating it must be able to create Apps for an allowed
 * owner, which for an organization means an owner or App manager. That is the
 * only proof setup trusts. Everything after it needs the session cookie it
 * issues, or the dashboard password it generates.
 */

export interface GitHubAppRecord {
  id: number
  slug: string
  owner: string
  htmlUrl: string
  privateKey: string
  webhookSecret: string
  gitName: string
  gitEmail: string
}

export interface ProviderCredentials {
  claudeToken: string | null
  codexAuth: string | null
  zaiApiKey: string | null
}

export interface SetupRecord {
  app: GitHubAppRecord | null
  dashboardPassword: string | null
  /** SHA-256 of the setup session cookie, issued once the App exists. */
  sessionHash: string | null
  manifestState: { hash: string; expiresAt: number } | null
  providers: ProviderCredentials
  mutationsEnabled: boolean
  issueCutoff: string | null
}

export const EMPTY_SETUP: SetupRecord = {
  app: null,
  dashboardPassword: null,
  sessionHash: null,
  manifestState: null,
  providers: { claudeToken: null, codexAuth: null, zaiApiKey: null },
  mutationsEnabled: true,
  issueCutoff: null,
}

export interface SetupStore {
  read: () => Promise<SetupRecord>
  write: (record: SetupRecord) => Promise<void>
  /** Restart the controller so it starts on the saved inputs. */
  restart: (options: { forgetCodexLogin: boolean }) => Promise<void>
}

export interface SetupDependencies {
  store: SetupStore
  /** The GitHub owners the controller may act on, from `ALLOWED_OWNERS`. */
  allowedOwners: string[]
  fetch: typeof fetch
  now: () => number
}

/** The controller can run once it has an App and at least one Agent provider. */
export function isReady(record: SetupRecord): boolean {
  const { claudeToken, codexAuth, zaiApiKey } = record.providers
  return record.app !== null && record.dashboardPassword !== null && (claudeToken ?? codexAuth ?? zaiApiKey) !== null
}

export const DASHBOARD_USER = 'agent'
const SESSION_COOKIE = 'wolfstar_setup'
const STATE_COOKIE = 'wolfstar_setup_state'
const MANIFEST_STATE_SECONDS = 60 * 60
const GITHUB_API = 'https://api.github.com'
const USER_AGENT = 'wolfstar-github-edge'

/** The permissions and events the controller documents in its README. */
export function appManifest(origin: string, owner: string, suffix: string): Record<string, unknown> {
  return {
    // App names are global on GitHub and capped at 34 characters.
    name: `${owner.slice(0, 22)}-agent-${suffix}`,
    url: origin,
    hook_attributes: { url: `${origin}/webhook`, active: true },
    redirect_url: `${origin}/setup/callback`,
    setup_url: `${origin}/setup/installed`,
    setup_on_update: true,
    public: false,
    default_permissions: {
      actions: 'write',
      administration: 'read',
      checks: 'write',
      contents: 'write',
      deployments: 'write',
      issues: 'write',
      metadata: 'read',
      pull_requests: 'write',
      statuses: 'read',
    },
    default_events: [
      'check_run',
      'check_suite',
      'issue_comment',
      'issues',
      'pull_request',
      'pull_request_review',
      'push',
      'status',
    ],
  }
}

function randomToken(bytes = 32): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...values))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

export async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Compares two secrets through their digests, so the comparison time says nothing about either. */
async function sameSecret(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(left), sha256(right)])
  let difference = 0
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return difference === 0
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=')
  }
  return null
}

function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/setup; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}

/** Basic auth with the dashboard password, the same credential the controller checks. */
export async function hasDashboardPassword(request: Request, record: SetupRecord): Promise<boolean> {
  const header = request.headers.get('authorization')
  if (record.dashboardPassword === null || header === null || !header.startsWith('Basic ')) return false
  let decoded: string
  try {
    decoded = atob(header.slice('Basic '.length))
  } catch {
    return false
  }
  const separator = decoded.indexOf(':')
  if (separator === -1 || decoded.slice(0, separator) !== DASHBOARD_USER) return false
  return sameSecret(decoded.slice(separator + 1), record.dashboardPassword)
}

async function hasSession(request: Request, record: SetupRecord): Promise<boolean> {
  const value = cookie(request, SESSION_COOKIE)
  return value !== null && record.sessionHash !== null && (await sameSecret(await sha256(value), record.sessionHash))
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function page(title: string, body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'text/html; charset=utf-8')
  headers.set('cache-control', 'no-store')
  headers.set('x-frame-options', 'DENY')
  // same-origin, not no-referrer: no-referrer makes a browser send `Origin: null` on the form post.
  headers.set('referrer-policy', 'same-origin')
  headers.set(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com 'self'",
  )
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;color:#1f2328}code,textarea,input{font:14px ui-monospace,monospace}textarea,input[type=password],input[type=text]{width:100%;box-sizing:border-box;padding:.4rem}label{display:block;margin-top:1rem;font-weight:600}small{color:#59636e;font-weight:400}button{margin-top:1.5rem;padding:.5rem 1rem;font-size:1rem}.box{background:#f6f8fa;padding:1rem;border-radius:6px;word-break:break-all}</style></head><body>${body}</body></html>`,
    { ...init, headers },
  )
}

function redirect(location: string, headers: HeadersInit = {}): Response {
  const response = new Response(null, { status: 303, headers })
  response.headers.set('location', location)
  return response
}

function unauthorized(): Response {
  return new Response('Sign in with the dashboard password.', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="Wolfstar GitHub Agent", charset="UTF-8"' },
  })
}

function primaryOwner(allowedOwners: string[]): string | null {
  return allowedOwners[0]?.split('/')[0] ?? null
}

async function githubJson(dependencies: SetupDependencies, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await dependencies.fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT, ...init.headers },
  })
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}.`)
  return response.json()
}

/** Step one: post the manifest to GitHub, bound to this browser by a state cookie. */
async function startSetup(request: Request, dependencies: SetupDependencies, record: SetupRecord): Promise<Response> {
  const owner = primaryOwner(dependencies.allowedOwners)
  if (owner === null) return page('Setup', '<h1>Setup</h1><p>Set <code>ALLOWED_OWNERS</code> in wrangler.jsonc.</p>')

  const account = (await githubJson(dependencies, `/users/${encodeURIComponent(owner)}`)) as { type?: string }
  const origin = new URL(request.url).origin
  const state = randomToken()
  await dependencies.store.write({
    ...record,
    manifestState: { hash: await sha256(state), expiresAt: dependencies.now() + MANIFEST_STATE_SECONDS * 1000 },
  })
  const action =
    account.type === 'Organization'
      ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
      : 'https://github.com/settings/apps/new'
  const manifest = JSON.stringify(
    appManifest(
      origin,
      owner,
      randomToken(3)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, 'x'),
    ),
  )

  return page(
    'Set up the Wolfstar GitHub Agent',
    `<h1>Set up the Wolfstar GitHub Agent</h1>
<p>This creates a private GitHub App owned by <code>${escapeHtml(owner)}</code>, with the permissions and webhook the agent needs. GitHub asks you to confirm the name.</p>
<form method="post" action="${escapeHtml(action)}?state=${encodeURIComponent(state)}">
<input type="hidden" name="manifest" value="${escapeHtml(manifest)}">
<button type="submit">Create the GitHub App</button>
</form>`,
    { headers: { 'set-cookie': setCookie(STATE_COOKIE, state, MANIFEST_STATE_SECONDS) } },
  )
}

interface ManifestConversion {
  id: number
  slug: string
  owner: { login: string }
  html_url: string
  pem: string
  webhook_secret: string | null
}

/** Step two: GitHub returns here with a one-time code for the App's credentials. */
async function finishManifest(
  request: Request,
  dependencies: SetupDependencies,
  record: SetupRecord,
): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const browserState = cookie(request, STATE_COOKIE)
  if (
    code === null ||
    !/^[\w-]{1,128}$/.test(code) ||
    state === null ||
    browserState === null ||
    record.manifestState === null ||
    record.manifestState.expiresAt < dependencies.now() ||
    !(await sameSecret(state, browserState)) ||
    !(await sameSecret(await sha256(state), record.manifestState.hash))
  )
    return page('Setup expired', '<h1>Setup expired</h1><p><a href="/setup">Start again</a>.</p>', { status: 400 })

  const app = (await githubJson(dependencies, `/app-manifests/${code}/conversions`, {
    method: 'POST',
  })) as ManifestConversion
  const owner = app.owner.login
  if (!dependencies.allowedOwners.some((allowed) => allowed.split('/')[0]!.toLowerCase() === owner.toLowerCase()))
    return page(
      'Owner not allowed',
      `<h1>Owner not allowed</h1><p>The App belongs to <code>${escapeHtml(owner)}</code>, which <code>ALLOWED_OWNERS</code> does not list. Delete it on GitHub and start again.</p>`,
      { status: 403 },
    )
  if (app.webhook_secret === null)
    return page(
      'No webhook secret',
      '<h1>No webhook secret</h1><p>GitHub created the App without one. Delete it and start again.</p>',
      {
        status: 502,
      },
    )

  // Commits carry the App's bot identity, which GitHub links to the App.
  const botLogin = `${app.slug}[bot]`
  const bot = (await githubJson(dependencies, `/users/${encodeURIComponent(botLogin)}`).catch(() => null)) as {
    id?: number
  } | null
  const session = randomToken()
  const today = new Date(dependencies.now())
  // Thirty days back, so the first start picks up recent issues and leaves the old backlog alone.
  const cutoff = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  await dependencies.store.write({
    ...record,
    app: {
      id: app.id,
      slug: app.slug,
      owner,
      htmlUrl: app.html_url,
      privateKey: app.pem,
      webhookSecret: app.webhook_secret,
      gitName: botLogin,
      gitEmail:
        bot?.id === undefined
          ? `${botLogin}@users.noreply.github.com`
          : `${bot.id}+${botLogin}@users.noreply.github.com`,
    },
    dashboardPassword: randomToken(),
    sessionHash: await sha256(session),
    manifestState: null,
    issueCutoff: cutoff,
  })
  const headers = new Headers({ location: '/setup/providers' })
  headers.append('set-cookie', setCookie(SESSION_COOKIE, session, 24 * 60 * 60))
  headers.append('set-cookie', setCookie(STATE_COOKIE, '', 0))
  return new Response(null, { status: 303, headers })
}

function providersPage(record: SetupRecord, origin: string, saved: boolean): Response {
  const app = record.app!
  const set = (value: string | null): string => (value === null ? '' : ' <small>(saved, leave empty to keep)</small>')
  return page(
    'Agent providers',
    `<h1>Agent providers</h1>
${saved ? '<p><strong>Saved.</strong> The controller is restarting with these settings.</p>' : ''}
<p>1. <a href="${escapeHtml(app.htmlUrl)}/installations/new">Install the GitHub App</a> on the repositories the agent should work on.</p>
<p>2. Add at least one Agent provider. Each one runs on that provider's own subscription.</p>
<form method="post" action="/setup/providers">
<label>Claude <small>output of <code>claude setup-token</code></small>${set(record.providers.claudeToken)}<input type="password" name="claude_token" autocomplete="off"></label>
<label>Codex <small>contents of <code>~/.codex/auth.json</code> after <code>codex login</code></small>${set(record.providers.codexAuth)}<textarea name="codex_auth" rows="4" autocomplete="off"></textarea></label>
<label>opencode <small>GLM Coding Plan API key</small>${set(record.providers.zaiApiKey)}<input type="password" name="zai_api_key" autocomplete="off"></label>
<label><input type="checkbox" name="mutations_enabled"${record.mutationsEnabled ? ' checked' : ''}> Let the agent write to GitHub <small>comments, labels, pull requests, pushes</small></label>
<button type="submit">Save and start</button>
</form>
<h2>Dashboard</h2>
<p>Open <a href="${escapeHtml(origin)}/">${escapeHtml(origin)}/</a> and sign in as <code>${DASHBOARD_USER}</code> with this password. Save it now. This page shows it again only after you sign in with it.</p>
<p class="box"><code>${escapeHtml(record.dashboardPassword ?? '')}</code></p>`,
  )
}

async function canEditProviders(request: Request, record: SetupRecord): Promise<boolean> {
  return (await hasSession(request, record)) || (await hasDashboardPassword(request, record))
}

/**
 * A form post from this site, not from another one.
 *
 * Browsers send the page origin. Some send `Origin: null` instead, under a
 * strict referrer policy or from a privacy extension, and then
 * `Sec-Fetch-Site`, which a page cannot set, still says where it came from.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (origin === new URL(request.url).origin) return true
  return (origin === null || origin === 'null') && request.headers.get('sec-fetch-site') === 'same-origin'
}

async function saveProviders(
  request: Request,
  dependencies: SetupDependencies,
  record: SetupRecord,
): Promise<Response> {
  // A form post from another site must not change the controller's credentials.
  if (!isSameOrigin(request)) return new Response('Request origin is not allowed.', { status: 403 })
  const form = await request.formData()
  const text = (name: string): string | null => {
    const value = form.get(name)
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  }

  const codexAuth = text('codex_auth')
  if (codexAuth !== null) {
    try {
      JSON.parse(codexAuth)
    } catch {
      return page(
        'Codex login is not JSON',
        '<h1>Codex login is not JSON</h1><p>Paste the whole <code>~/.codex/auth.json</code>. <a href="/setup/providers">Back</a>.</p>',
        {
          status: 400,
        },
      )
    }
  }
  const next: SetupRecord = {
    ...record,
    providers: {
      claudeToken: text('claude_token') ?? record.providers.claudeToken,
      codexAuth: codexAuth ?? record.providers.codexAuth,
      zaiApiKey: text('zai_api_key') ?? record.providers.zaiApiKey,
    },
    mutationsEnabled: form.get('mutations_enabled') === 'on',
  }
  await dependencies.store.write(next)
  await dependencies.store.restart({ forgetCodexLogin: codexAuth !== null })
  return providersPage(next, new URL(request.url).origin, true)
}

/** Every `/setup` route. Returns null for any other path. */
export async function handleSetup(request: Request, dependencies: SetupDependencies): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/setup' && !url.pathname.startsWith('/setup/')) return null
  const record = await dependencies.store.read()

  switch (`${request.method} ${url.pathname}`) {
    case 'GET /setup':
      if (record.app !== null) return redirect('/setup/providers')
      return startSetup(request, dependencies, record)
    case 'GET /setup/callback':
      if (record.app !== null) return redirect('/setup/providers')
      return finishManifest(request, dependencies, record)
    case 'GET /setup/providers':
      if (record.app === null) return redirect('/setup')
      if (!(await canEditProviders(request, record))) return unauthorized()
      return providersPage(record, url.origin, false)
    case 'POST /setup/providers':
      if (record.app === null) return redirect('/setup')
      if (!(await canEditProviders(request, record))) return unauthorized()
      return saveProviders(request, dependencies, record)
    case 'GET /setup/installed':
      // GitHub sends the browser here after an installation changes. The
      // controller clones new repositories when it starts, so a signed in
      // person restarts it. Anyone else only gets a redirect.
      if (record.app !== null && isReady(record) && (await canEditProviders(request, record)))
        await dependencies.store.restart({ forgetCodexLogin: false })
      return redirect(isReady(record) ? '/' : '/setup/providers')
    default:
      return new Response('Not found.', { status: 404 })
  }
}
