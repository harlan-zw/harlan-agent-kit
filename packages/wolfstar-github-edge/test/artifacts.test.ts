import { describe, expect, it } from 'vitest'
import type { Env } from '../src/env.ts'
import { artifactsAccess, issueSnapshotAccess } from '../src/artifacts.ts'

class ArtifactsFailure extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

interface Calls {
  created: string[]
  tokens: { scope: string; ttl: number | undefined }[]
  disposed: number
}

/** A repository store that behaves like the binding: `get` throws NOT_FOUND, `create` throws ALREADY_EXISTS. */
function fakeArtifacts(existing: string[] = []): { artifacts: Artifacts; calls: Calls } {
  const names = new Set(existing)
  const calls: Calls = { created: [], tokens: [], disposed: 0 }
  const artifacts = {
    async get(name: string) {
      if (!names.has(name)) throw new ArtifactsFailure('NOT_FOUND')
      return {
        async info() {
          return { remote: `https://account.artifacts.cloudflare.net/git/ns/${name}.git` }
        },
        async createToken(scope: string, ttl?: number) {
          calls.tokens.push({ scope, ttl })
          return { plaintext: `art_v1_${scope}`, scope, id: 't', expiresAt: '' }
        },
        [Symbol.dispose]() {
          calls.disposed += 1
        },
      }
    },
    async create(name: string) {
      if (names.has(name)) throw new ArtifactsFailure('ALREADY_EXISTS')
      names.add(name)
      calls.created.push(name)
      return {}
    },
  }
  return { artifacts: artifacts as unknown as Artifacts, calls }
}

function ask(env: Partial<Env>, body: unknown, init: RequestInit = {}, path = '/access'): Promise<Response> {
  return artifactsAccess(
    new Request(`http://artifacts.internal${path}`, { method: 'POST', body: JSON.stringify(body), ...init }),
    env as Env,
    {} as never,
  ) as Promise<Response>
}

describe('snapshot access', () => {
  it('creates the repository for a write token and hands back its remote', async () => {
    const { artifacts, calls } = fakeArtifacts()
    const access = await issueSnapshotAccess(artifacts, 'wolfstar-project-staryl', 'write')

    expect(calls.created).toEqual(['wolfstar-project-staryl'])
    expect(access).toEqual({
      remote: 'https://account.artifacts.cloudflare.net/git/ns/wolfstar-project-staryl.git',
      token: 'art_v1_write',
    })
    expect(calls.tokens).toEqual([{ scope: 'write', ttl: 900 }])
    expect(calls.disposed).toBe(1)
  })

  it('reuses a repository that exists', async () => {
    const { artifacts, calls } = fakeArtifacts(['wolfstar-project-staryl'])
    await issueSnapshotAccess(artifacts, 'wolfstar-project-staryl', 'write')
    expect(calls.created).toEqual([])
  })

  it('answers null for a read token when nothing was ever saved, and creates nothing', async () => {
    const { artifacts, calls } = fakeArtifacts()
    expect(await issueSnapshotAccess(artifacts, 'wolfstar-project-staryl', 'read')).toBeNull()
    expect(calls.created).toEqual([])
  })

  it('survives losing a creation race', async () => {
    const { artifacts } = fakeArtifacts()
    const racing = {
      ...artifacts,
      get: (() => {
        let first = true
        return async (name: string) => {
          if (first) {
            first = false
            throw new ArtifactsFailure('NOT_FOUND')
          }
          return artifacts.get(name)
        }
      })(),
      create: async (name: string) => {
        await artifacts.create(name)
        throw new ArtifactsFailure('ALREADY_EXISTS')
      },
    } as unknown as Artifacts
    expect(await issueSnapshotAccess(racing, 'wolfstar-project-staryl', 'write')).not.toBeNull()
  })

  it('does not hide an error it cannot handle', async () => {
    const broken = {
      get: async () => {
        throw new ArtifactsFailure('UPSTREAM_UNAVAILABLE')
      },
    } as unknown as Artifacts
    await expect(issueSnapshotAccess(broken, 'wolfstar-project-staryl', 'write')).rejects.toThrow(
      'UPSTREAM_UNAVAILABLE',
    )
  })
})

describe('the Container route', () => {
  it('answers a signed in Container with access', async () => {
    const { artifacts } = fakeArtifacts()
    const response = await ask({ ARTIFACTS: artifacts }, { repository: 'wolfstar-project-staryl', scope: 'write' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ token: 'art_v1_write' })
  })

  it.each([
    ['a name with a slash', { repository: 'wolfstar-project/staryl', scope: 'write' }],
    ['an upper case name', { repository: 'Wolfstar-Staryl', scope: 'write' }],
    ['a name that starts with a dot', { repository: '.hidden-repo', scope: 'write' }],
    ['a missing scope', { repository: 'wolfstar-project-staryl' }],
    ['an unknown scope', { repository: 'wolfstar-project-staryl', scope: 'admin' }],
  ])('refuses %s', async (_label, body) => {
    const { artifacts, calls } = fakeArtifacts()
    const response = await ask({ ARTIFACTS: artifacts }, body)
    expect(response.status).toBe(400)
    expect(calls.created).toEqual([])
  })

  it('answers 404 when there is nothing to restore', async () => {
    const { artifacts } = fakeArtifacts()
    expect((await ask({ ARTIFACTS: artifacts }, { repository: 'wolfstar-project-staryl', scope: 'read' })).status).toBe(
      404,
    )
  })

  it('refuses another path and another method', async () => {
    const { artifacts } = fakeArtifacts()
    expect((await ask({ ARTIFACTS: artifacts }, {}, {}, '/tokens')).status).toBe(404)
    const get = await artifactsAccess(
      new Request('http://artifacts.internal/access'),
      { ARTIFACTS: artifacts } as Env,
      {} as never,
    )
    expect(get.status).toBe(405)
  })

  it('does not leak a failure to the Container', async () => {
    const broken = {
      get: async () => {
        throw new ArtifactsFailure('INTERNAL_ERROR')
      },
    } as unknown as Artifacts
    const response = await ask({ ARTIFACTS: broken }, { repository: 'wolfstar-project-staryl', scope: 'write' })
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('INTERNAL_ERROR')
  })
})
