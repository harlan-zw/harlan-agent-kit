import { describe, expect, it } from 'vitest'
import { handleRequest } from '../src/app.ts'
import { appManifest, isReady } from '../src/setup.ts'
import { DASHBOARD_PASSWORD, ORIGIN, READY_SETUP, createTestEdge } from './fixtures.ts'

function github(owner: { login: string; type: string } = { login: 'wolfstar-project', type: 'Organization' }) {
  return async (url: string): Promise<Response> => {
    if (url === `https://api.github.com/users/${owner.login}`) return Response.json({ type: owner.type })
    if (url === 'https://api.github.com/app-manifests/the-code/conversions')
      return Response.json({
        id: 42,
        slug: 'wolfstar-project-agent-abcd',
        owner: { login: owner.login },
        html_url: 'https://github.com/apps/wolfstar-project-agent-abcd',
        pem: '-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n',
        webhook_secret: 'generated-webhook-secret',
      })
    if (url === 'https://api.github.com/users/wolfstar-project-agent-abcd%5Bbot%5D') return Response.json({ id: 9 })
    return new Response(null, { status: 404 })
  }
}

function cookiesOf(response: Response): Record<string, string> {
  return Object.fromEntries(
    response.headers.getSetCookie().map((cookie) => {
      const [pair] = cookie.split(';')
      const [name, value] = pair!.split('=')
      return [name!, value ?? '']
    }),
  )
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

async function createApp(edge: ReturnType<typeof createTestEdge>) {
  const start = await handleRequest(new Request(`${ORIGIN}/setup`), edge.dependencies)
  const html = await start.text()
  const state = /state=([^"&]+)/.exec(html)![1]!
  const callback = await handleRequest(
    new Request(`${ORIGIN}/setup/callback?code=the-code&state=${state}`, {
      headers: { cookie: cookieHeader(cookiesOf(start)) },
    }),
    edge.dependencies,
  )
  return { start, html, state, callback }
}

describe('GitHub App setup', () => {
  it('posts a manifest to the organization with the permissions and webhook the controller needs', async () => {
    const edge = createTestEdge({ github: github() })

    const { html } = await createApp(edge)

    expect(html).toContain('action="https://github.com/organizations/wolfstar-project/settings/apps/new?state=')
    const manifest = JSON.parse(
      /name="manifest" value="([^"]+)"/.exec(html)![1]!.replaceAll('&quot;', '"').replaceAll('&amp;', '&'),
    )
    expect(manifest).toMatchObject({
      url: ORIGIN,
      hook_attributes: { url: `${ORIGIN}/webhook`, active: true },
      redirect_url: `${ORIGIN}/setup/callback`,
      public: false,
      default_permissions: { contents: 'write', pull_requests: 'write', issues: 'write', checks: 'write' },
    })
    expect(manifest.name.length).toBeLessThanOrEqual(34)
  })

  it('posts to the personal settings page when the owner is a user', async () => {
    const edge = createTestEdge({ github: github({ login: 'wolfstar-project', type: 'User' }) })

    const { html } = await createApp(edge)

    expect(html).toContain('action="https://github.com/settings/apps/new?state=')
  })

  it('saves the App, its bot identity, and a new dashboard password, then opens the provider form', async () => {
    const edge = createTestEdge({ github: github() })

    const { callback } = await createApp(edge)

    expect(callback.status).toBe(303)
    expect(callback.headers.get('location')).toBe('/setup/providers')
    expect(edge.setup().app).toEqual({
      id: 42,
      slug: 'wolfstar-project-agent-abcd',
      owner: 'wolfstar-project',
      htmlUrl: 'https://github.com/apps/wolfstar-project-agent-abcd',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n',
      webhookSecret: 'generated-webhook-secret',
      gitName: 'wolfstar-project-agent-abcd[bot]',
      gitEmail: '9+wolfstar-project-agent-abcd[bot]@users.noreply.github.com',
    })
    expect(edge.setup().dashboardPassword?.length).toBeGreaterThanOrEqual(32)
    expect(edge.setup().issueCutoff).toBe('2026-09-14')
    expect(isReady(edge.setup())).toBe(false)
  })

  it('refuses a callback without the state this browser started with', async () => {
    const edge = createTestEdge({ github: github() })
    const { state } = await createApp(createTestEdge({ github: github() }))
    await handleRequest(new Request(`${ORIGIN}/setup`), edge.dependencies)

    const callback = await handleRequest(
      new Request(`${ORIGIN}/setup/callback?code=the-code&state=${state}`, {
        headers: { cookie: `wolfstar_setup_state=${state}` },
      }),
      edge.dependencies,
    )

    expect(callback.status).toBe(400)
    expect(edge.setup().app).toBeNull()
  })

  it('refuses an App created under an owner the deployment does not allow', async () => {
    const edge = createTestEdge({ github: github({ login: 'someone-else', type: 'User' }) })
    // The browser starts setup for an allowed owner, then creates the App under another one on GitHub.
    edge.dependencies.allowedOwners = ['someone-else']
    const start = await handleRequest(new Request(`${ORIGIN}/setup`), edge.dependencies)
    const state = /state=([^"&]+)/.exec(await start.text())![1]!
    edge.dependencies.allowedOwners = ['wolfstar-project']

    const callback = await handleRequest(
      new Request(`${ORIGIN}/setup/callback?code=the-code&state=${state}`, {
        headers: { cookie: cookieHeader(cookiesOf(start)) },
      }),
      edge.dependencies,
    )

    expect(callback.status).toBe(403)
    expect(edge.setup().app).toBeNull()
  })

  it('keeps the manifest page closed once the App exists', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    const response = await handleRequest(new Request(`${ORIGIN}/setup`), edge.dependencies)

    expect(response.headers.get('location')).toBe('/setup/providers')
  })

  it('names the manifest within the GitHub App name limit for a long owner', () => {
    expect((appManifest(ORIGIN, 'a'.repeat(39), 'abcd').name as string).length).toBeLessThanOrEqual(34)
  })
})

describe('provider setup', () => {
  async function withApp() {
    const edge = createTestEdge({ github: github() })
    const { callback } = await createApp(edge)
    return { edge, cookies: cookieHeader(cookiesOf(callback)) }
  }

  it('shows the form and the dashboard password to the browser that created the App', async () => {
    const { edge, cookies } = await withApp()

    const response = await handleRequest(
      new Request(`${ORIGIN}/setup/providers`, { headers: { cookie: cookies } }),
      edge.dependencies,
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain(edge.setup().dashboardPassword!)
  })

  it('asks anyone else for the dashboard password', async () => {
    const { edge } = await withApp()

    const response = await handleRequest(new Request(`${ORIGIN}/setup/providers`), edge.dependencies)

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('Basic')
  })

  it('accepts the dashboard password after setup', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })
    const authorization = `Basic ${btoa(`agent:${DASHBOARD_PASSWORD}`)}`

    const response = await handleRequest(
      new Request(`${ORIGIN}/setup/providers`, { headers: { authorization } }),
      edge.dependencies,
    )

    expect(response.status).toBe(200)
    const wrong = await handleRequest(
      new Request(`${ORIGIN}/setup/providers`, { headers: { authorization: `Basic ${btoa('agent:wrong')}` } }),
      edge.dependencies,
    )
    expect(wrong.status).toBe(401)
  })

  it('saves the providers, keeps empty fields, and restarts the controller', async () => {
    const { edge, cookies } = await withApp()
    const form = new URLSearchParams({
      claude_token: 'sk-ant-oat01-token',
      codex_auth: '{"tokens":{}}',
      mutations_enabled: 'on',
    })

    const response = await handleRequest(
      new Request(`${ORIGIN}/setup/providers`, {
        method: 'POST',
        headers: { cookie: cookies, origin: ORIGIN },
        body: form,
      }),
      edge.dependencies,
    )

    expect(response.status).toBe(200)
    expect(edge.setup().providers).toEqual({
      claudeToken: 'sk-ant-oat01-token',
      codexAuth: '{"tokens":{}}',
      zaiApiKey: null,
      workersAiToken: null,
      workersAiAccountId: null,
    })
    expect(edge.setup().mutationsEnabled).toBe(true)
    expect(isReady(edge.setup())).toBe(true)
    expect(edge.restarts).toEqual([{ forgetCodexLogin: true }])

    await handleRequest(
      new Request(`${ORIGIN}/setup/providers`, {
        method: 'POST',
        headers: { cookie: cookies, origin: ORIGIN },
        body: new URLSearchParams({ zai_api_key: 'zai-key' }),
      }),
      edge.dependencies,
    )
    expect(edge.setup().providers).toEqual({
      claudeToken: 'sk-ant-oat01-token',
      codexAuth: '{"tokens":{}}',
      zaiApiKey: 'zai-key',
      workersAiToken: null,
      workersAiAccountId: null,
    })
    expect(edge.setup().mutationsEnabled).toBe(false)
    expect(edge.restarts.at(-1)).toEqual({ forgetCodexLogin: false })
  })

  it('refuses a provider form posted from another site', async () => {
    const { edge, cookies } = await withApp()

    const response = await handleRequest(
      new Request(`${ORIGIN}/setup/providers`, {
        method: 'POST',
        headers: { cookie: cookies, origin: 'https://evil.example' },
        body: new URLSearchParams({ claude_token: 'stolen' }),
      }),
      edge.dependencies,
    )

    expect(response.status).toBe(403)
    expect(edge.setup().providers.claudeToken).toBeNull()
  })

  it('accepts a form post whose browser sent Origin null from this same site', async () => {
    const { edge, cookies } = await withApp()

    const response = await handleRequest(
      new Request(`${ORIGIN}/setup/providers`, {
        method: 'POST',
        headers: { cookie: cookies, origin: 'null', 'sec-fetch-site': 'same-origin' },
        body: new URLSearchParams({ claude_token: 'sk-ant-oat01-token' }),
      }),
      edge.dependencies,
    )

    expect(response.status).toBe(200)
    expect(edge.setup().providers.claudeToken).toBe('sk-ant-oat01-token')
  })

  it('refuses Origin null from another site', async () => {
    const { edge, cookies } = await withApp()

    for (const site of ['cross-site', 'same-site', undefined]) {
      const response = await handleRequest(
        new Request(`${ORIGIN}/setup/providers`, {
          method: 'POST',
          headers: { cookie: cookies, origin: 'null', ...(site === undefined ? {} : { 'sec-fetch-site': site }) },
          body: new URLSearchParams({ claude_token: 'stolen' }),
        }),
        edge.dependencies,
      )
      expect(response.status).toBe(403)
    }
    expect(edge.setup().providers.claudeToken).toBeNull()
  })

  it('refuses a Codex login that is not JSON', async () => {
    const { edge, cookies } = await withApp()

    const response = await handleRequest(
      new Request(`${ORIGIN}/setup/providers`, {
        method: 'POST',
        headers: { cookie: cookies, origin: ORIGIN },
        body: new URLSearchParams({ codex_auth: 'not json' }),
      }),
      edge.dependencies,
    )

    expect(response.status).toBe(400)
    expect(edge.setup().providers.codexAuth).toBeNull()
  })

  it('restarts the controller after an installation only for a signed in person', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    await handleRequest(new Request(`${ORIGIN}/setup/installed?installation_id=1`), edge.dependencies)
    expect(edge.restarts).toEqual([])

    const authorization = `Basic ${btoa(`agent:${DASHBOARD_PASSWORD}`)}`
    const response = await handleRequest(
      new Request(`${ORIGIN}/setup/installed?installation_id=1`, { headers: { authorization } }),
      edge.dependencies,
    )
    expect(response.headers.get('location')).toBe('/')
    expect(edge.restarts).toEqual([{ forgetCodexLogin: false }])
  })
})

describe('Workers AI setup', () => {
  const ACCOUNT = '0123456789abcdef0123456789abcdef'

  function cloudflare(accounts: string[], modelsStatus = 200) {
    return async (url: string, init?: RequestInit): Promise<Response> => {
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization !== 'Bearer cf-token') return new Response(null, { status: 403 })
      if (url === 'https://api.cloudflare.com/client/v4/accounts?per_page=50')
        return Response.json({ result: accounts.map((id) => ({ id })) })
      if (url.startsWith('https://api.cloudflare.com/client/v4/accounts/') && url.includes('/ai/models/search'))
        return Response.json({ result: [] }, { status: modelsStatus })
      return new Response(null, { status: 404 })
    }
  }

  async function save(edge: ReturnType<typeof createTestEdge>, form: Record<string, string>) {
    return handleRequest(
      new Request(`${ORIGIN}/setup/providers`, {
        method: 'POST',
        headers: { authorization: `Basic ${btoa(`agent:${DASHBOARD_PASSWORD}`)}`, origin: ORIGIN },
        body: new URLSearchParams(form),
      }),
      edge.dependencies,
    )
  }

  it('finds the account from the token, checks Workers AI, and saves both', async () => {
    const edge = createTestEdge({ setup: READY_SETUP, github: cloudflare([ACCOUNT]) })

    const response = await save(edge, { workers_ai_token: 'cf-token' })

    expect(response.status).toBe(200)
    expect(edge.setup().providers).toMatchObject({ workersAiToken: 'cf-token', workersAiAccountId: ACCOUNT })
    expect(edge.github.map((call) => call.url)).toEqual([
      'https://api.cloudflare.com/client/v4/accounts?per_page=50',
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/models/search?per_page=1`,
    ])
  })

  it('runs on Workers AI alone', async () => {
    const edge = createTestEdge({
      setup: { ...READY_SETUP, providers: { ...READY_SETUP.providers, claudeToken: null } },
      github: cloudflare([ACCOUNT]),
    })

    await save(edge, { workers_ai_token: 'cf-token' })

    expect(isReady(edge.setup())).toBe(true)
  })

  it('asks for the account ID when the token sees several accounts, and accepts it typed', async () => {
    const other = 'fedcba9876543210fedcba9876543210'
    const edge = createTestEdge({ setup: READY_SETUP, github: cloudflare([ACCOUNT, other]) })

    expect((await save(edge, { workers_ai_token: 'cf-token' })).status).toBe(400)
    expect(edge.setup().providers.workersAiToken).toBeNull()

    expect((await save(edge, { workers_ai_token: 'cf-token', workers_ai_account_id: other })).status).toBe(200)
    expect(edge.setup().providers.workersAiAccountId).toBe(other)
  })

  it('refuses a token that cannot read Workers AI, or an account ID that is not one', async () => {
    const edge = createTestEdge({ setup: READY_SETUP, github: cloudflare([ACCOUNT], 403) })

    expect((await save(edge, { workers_ai_token: 'cf-token' })).status).toBe(400)
    expect((await save(edge, { workers_ai_token: 'wrong-token' })).status).toBe(400)
    expect((await save(edge, { workers_ai_token: 'cf-token', workers_ai_account_id: 'nope' })).status).toBe(400)
    expect(edge.setup().providers.workersAiToken).toBeNull()
  })

  it('keeps a saved Workers AI login when another field changes', async () => {
    const edge = createTestEdge({
      setup: {
        ...READY_SETUP,
        providers: { ...READY_SETUP.providers, workersAiToken: 'cf-token', workersAiAccountId: ACCOUNT },
      },
    })

    expect((await save(edge, { zai_api_key: 'zai-key' })).status).toBe(200)
    expect(edge.setup().providers).toMatchObject({ workersAiToken: 'cf-token', workersAiAccountId: ACCOUNT })
    expect(edge.github).toHaveLength(0)
  })
})

describe('GitHub maintainer token', () => {
  async function save(edge: ReturnType<typeof createTestEdge>, form: Record<string, string>) {
    return handleRequest(
      new Request(`${ORIGIN}/setup/providers`, {
        method: 'POST',
        headers: { authorization: `Basic ${btoa(`agent:${DASHBOARD_PASSWORD}`)}`, origin: ORIGIN },
        body: new URLSearchParams(form),
      }),
      edge.dependencies,
    )
  }

  const github = async (url: string, init?: RequestInit): Promise<Response> =>
    url === 'https://api.github.com/user' && new Headers(init?.headers).get('authorization') === 'Bearer ghp_valid'
      ? Response.json({ login: 'RedStar071' })
      : new Response(null, { status: 401 })

  it('saves a token GitHub accepts, with the login it belongs to', async () => {
    const edge = createTestEdge({ setup: READY_SETUP, github })

    expect((await save(edge, { github_user_token: 'ghp_valid' })).status).toBe(200)
    expect(edge.setup().githubUser).toEqual({ token: 'ghp_valid', login: 'RedStar071' })
  })

  it('refuses a token GitHub rejects, and keeps a saved one when the field is empty', async () => {
    const edge = createTestEdge({
      setup: { ...READY_SETUP, githubUser: { token: 'ghp_valid', login: 'RedStar071' } },
      github,
    })

    expect((await save(edge, { github_user_token: 'ghp_wrong' })).status).toBe(400)
    expect((await save(edge, { claude_token: 'sk-ant-oat01-other' })).status).toBe(200)
    expect(edge.setup().githubUser).toEqual({ token: 'ghp_valid', login: 'RedStar071' })
  })
})
