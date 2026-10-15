import { describe, expect, it } from 'vitest'
import { handleRequest } from '../src/app.ts'
import { DASHBOARD_PASSWORD, ORIGIN, READY_SETUP, createTestEdge } from './fixtures.ts'

const BASIC = `Basic ${btoa(`agent:${DASHBOARD_PASSWORD}`)}`
const ACCOUNT = '0123456789abcdef0123456789abcdef'

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { headers })
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/setup/api/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, authorization: BASIC, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const github = async (url: string, init?: RequestInit): Promise<Response> => {
  const authorization = new Headers(init?.headers).get('authorization')
  if (url === 'https://api.github.com/user')
    return authorization === 'Bearer ghp_valid'
      ? Response.json({ login: 'RedStar071' })
      : new Response(null, { status: 401 })
  if (url === 'https://api.cloudflare.com/client/v4/accounts?per_page=50')
    return authorization === 'Bearer cf-token'
      ? Response.json({ result: [{ id: ACCOUNT }] })
      : new Response(null, { status: 403 })
  if (url.includes('/ai/models/search')) return Response.json({ result: [] })
  return new Response(null, { status: 404 })
}

describe('settings state', () => {
  it('is closed to a request the controller does not know', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    for (const headers of [{}, { authorization: 'Basic YWdlbnQ6d3Jvbmc=' }, { cookie: 'controller_session=expired' }]) {
      const response = await handleRequest(get('/setup/api/state', headers), edge.dependencies)
      expect(response.status).toBe(401)
    }
  })

  it('answers the dashboard password, and tells the browser not to cache it', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    const response = await handleRequest(get('/setup/api/state', { authorization: BASIC }), edge.dependencies)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      ready: true,
      app: {
        slug: 'wolfstar-project-agent-abcd',
        owner: 'wolfstar-project',
        htmlUrl: 'https://github.com/apps/wolfstar-project-agent-abcd',
        installUrl: 'https://github.com/apps/wolfstar-project-agent-abcd/installations/new',
      },
      providers: {
        claude: { configured: true },
        codex: { configured: false },
        opencode: { configured: false },
        workersAi: { configured: false, accountId: null },
      },
      githubUser: null,
      mutationsEnabled: true,
    })
  })

  it('answers whoever the controller says is signed in, so a passkey session needs no second login', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    const response = await handleRequest(
      get('/setup/api/state', { cookie: 'controller_session=valid' }),
      edge.dependencies,
    )

    expect(response.status).toBe(200)
  })

  it('never carries a secret, for any configured provider', async () => {
    const secrets = [
      'sk-ant-oat01-token',
      '{"tokens":{"refresh":"codex-secret"}}',
      'zai-secret',
      'cf-secret',
      'ghp_secret',
    ]
    const edge = createTestEdge({
      setup: {
        ...READY_SETUP,
        providers: {
          claudeToken: secrets[0]!,
          codexAuth: secrets[1]!,
          zaiApiKey: secrets[2]!,
          workersAiToken: secrets[3]!,
          workersAiAccountId: ACCOUNT,
        },
        githubUser: { token: secrets[4]!, login: 'RedStar071' },
      },
    })

    const text = await (
      await handleRequest(get('/setup/api/state', { authorization: BASIC }), edge.dependencies)
    ).text()

    for (const secret of secrets) expect(text).not.toContain(secret)
    expect(text).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(text).not.toContain(DASHBOARD_PASSWORD)
    expect(JSON.parse(text)).toMatchObject({
      providers: { codex: { configured: true }, workersAi: { configured: true, accountId: ACCOUNT } },
      githubUser: { login: 'RedStar071' },
    })
  })

  it('says setup is incomplete before the App exists', async () => {
    const edge = createTestEdge()

    const response = await handleRequest(get('/setup/api/state', { authorization: BASIC }), edge.dependencies)

    expect(response.status).toBe(409)
  })
})

describe('settings changes', () => {
  it('sets a provider, restarts the controller, and returns the new view', async () => {
    const edge = createTestEdge({ setup: READY_SETUP, github })

    const response = await handleRequest(post({ workersAiToken: 'cf-token' }), edge.dependencies)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      restarting: true,
      providers: { workersAi: { configured: true, accountId: ACCOUNT } },
    })
    expect(edge.setup().providers).toMatchObject({ workersAiToken: 'cf-token', workersAiAccountId: ACCOUNT })
    expect(edge.restarts).toEqual([{ forgetCodexLogin: false }])
  })

  it('removes a provider with null, together with the account it was bound to', async () => {
    const edge = createTestEdge({
      setup: {
        ...READY_SETUP,
        providers: {
          ...READY_SETUP.providers,
          zaiApiKey: 'zai-key',
          workersAiToken: 'cf-token',
          workersAiAccountId: ACCOUNT,
        },
      },
    })

    const response = await handleRequest(post({ workersAiToken: null }), edge.dependencies)

    expect(response.status).toBe(200)
    expect(edge.setup().providers).toMatchObject({
      claudeToken: 'sk-ant-oat01-token',
      zaiApiKey: 'zai-key',
      workersAiToken: null,
      workersAiAccountId: null,
    })
  })

  it('keeps what it is not asked to change', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    await handleRequest(post({ zaiApiKey: 'zai-key', claudeToken: '   ' }), edge.dependencies)

    expect(edge.setup().providers).toMatchObject({ claudeToken: 'sk-ant-oat01-token', zaiApiKey: 'zai-key' })
  })

  it('refuses to remove the last Agent provider, because the controller could not start', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    const response = await handleRequest(post({ claudeToken: null }), edge.dependencies)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ title: 'Keep one Agent provider' })
    expect(edge.setup().providers.claudeToken).toBe('sk-ant-oat01-token')
    expect(edge.restarts).toEqual([])
  })

  it('forgets the saved Codex login when a new one arrives, or when it is removed', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    await handleRequest(post({ codexAuth: '{"tokens":{}}' }), edge.dependencies)
    await handleRequest(post({ codexAuth: null }), edge.dependencies)

    expect(edge.restarts).toEqual([{ forgetCodexLogin: true }, { forgetCodexLogin: true }])
    expect(edge.setup().providers.codexAuth).toBeNull()
  })

  it('checks a login before it saves it', async () => {
    const edge = createTestEdge({ setup: READY_SETUP, github })

    const notJson = await handleRequest(post({ codexAuth: 'not json' }), edge.dependencies)
    const badCloudflare = await handleRequest(post({ workersAiToken: 'wrong' }), edge.dependencies)
    const badGitHub = await handleRequest(post({ githubUserToken: 'ghp_wrong' }), edge.dependencies)

    expect([notJson.status, badCloudflare.status, badGitHub.status]).toEqual([400, 400, 400])
    expect(edge.setup().providers).toEqual(READY_SETUP.providers)
    expect(edge.setup().githubUser).toBeNull()
    expect(edge.restarts).toEqual([])
  })

  it('saves a maintainer token with the login GitHub reports, and can remove it', async () => {
    const edge = createTestEdge({ setup: READY_SETUP, github })

    await handleRequest(post({ githubUserToken: 'ghp_valid' }), edge.dependencies)
    expect(edge.setup().githubUser).toEqual({ token: 'ghp_valid', login: 'RedStar071' })

    await handleRequest(post({ githubUserToken: null }), edge.dependencies)
    expect(edge.setup().githubUser).toBeNull()
  })

  it('switches writes to GitHub on and off', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    await handleRequest(post({ mutationsEnabled: false }), edge.dependencies)

    expect(edge.setup().mutationsEnabled).toBe(false)
  })
})

describe('settings changes are guarded', () => {
  it('refuses a request nobody signed in', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    const response = await handleRequest(post({ zaiApiKey: 'x' }, { authorization: '' }), edge.dependencies)

    expect(response.status).toBe(401)
    expect(edge.setup().providers.zaiApiKey).toBeNull()
  })

  it('refuses another site, even when a session cookie rides along', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    const response = await handleRequest(
      post(
        { zaiApiKey: 'x' },
        { origin: 'https://evil.example', authorization: '', cookie: 'controller_session=valid' },
      ),
      edge.dependencies,
    )

    expect(response.status).toBe(403)
    expect(edge.setup().providers.zaiApiKey).toBeNull()
  })

  it('refuses a form post, which another site could forge', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    const response = await handleRequest(
      post('zaiApiKey=x', { 'content-type': 'application/x-www-form-urlencoded' }),
      edge.dependencies,
    )

    expect(response.status).toBe(415)
    expect(edge.setup().providers.zaiApiKey).toBeNull()
  })

  it('refuses a body with an unknown setting, a wrong type, or no JSON at all', async () => {
    const edge = createTestEdge({ setup: READY_SETUP })

    for (const body of [{ webhookSecret: 'x' }, { zaiApiKey: 5 }, { mutationsEnabled: 'yes' }, 'not json', []]) {
      const response = await handleRequest(post(body), edge.dependencies)
      expect(response.status).toBe(400)
    }
    expect(edge.restarts).toEqual([])
  })
})
