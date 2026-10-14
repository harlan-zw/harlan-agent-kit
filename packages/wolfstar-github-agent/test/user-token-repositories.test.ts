import type { InstalledRepository } from '../src/repository-discovery.ts'
import { describe, expect, it } from 'vitest'
import { createRoutedTokenProvider, createUserTokenProvider } from '../src/github-auth.ts'
import { createGitHubUserAccess } from '../src/github-user-access.ts'
import { buildRepositoryMappings, discoverUserRepositories } from '../src/repository-discovery.ts'
import { ok } from '../src/result.ts'

const installed: InstalledRepository = {
  github: 'wolfstar-project/example',
  defaultBranch: 'main',
  archived: false,
  fork: false,
  topics: [],
  authentication: 'app',
  owner: { login: 'wolfstar-project', type: 'User' },
}

function organizationRepository(github: string, archived = false, fork = false) {
  return {
    github,
    defaultBranch: 'main',
    archived,
    fork,
    topics: [],
    owner: { login: github.split('/')[0] as string, type: 'Organization' as const },
  }
}

describe('discoverUserRepositories', () => {
  const checkouts = [
    { github: 'wolfstar-project/example', checkout: '/home/wolfstar/pkg/example' },
    { github: 'nuxt-modules/sitemap', checkout: '/home/wolfstar/pkg/sitemap' },
    { github: 'nuxt-modules/sitemap', checkout: '/home/wolfstar/pkg/sitemap.fix-one' },
    { github: 'someone-else/tool', checkout: '/home/wolfstar/pkg/tool' },
  ]

  it('adds a maintained repository the App cannot reach', async () => {
    const read: string[] = []
    const { repositories } = await discoverUserRepositories({
      allowedOwners: ['wolfstar-project', 'nuxt-modules'],
      checkouts,
      installed: [installed],
      readRepository: (github) => {
        read.push(github)
        return Promise.resolve(organizationRepository(github))
      },
    })

    // The installed repository and the owner outside the allowlist never get read.
    expect(read).toEqual(['nuxt-modules/sitemap'])
    expect(repositories).toEqual([expect.objectContaining({ github: 'nuxt-modules/sitemap', authentication: 'user' })])
  })

  it('names a checkout whose remote points at a renamed repository, and maps nothing for it', async () => {
    // GitHub redirects the old name, so the read answers with the current one.
    const discovery = await discoverUserRepositories({
      allowedOwners: ['wolfstar-project', 'nuxt-modules'],
      checkouts: [{ github: 'wolfstar-project/massivemonster.co', checkout: '/home/wolfstar/sites/massivemonster.co' }],
      installed: [],
      readRepository: () => Promise.resolve(organizationRepository('wolfstar-project/massivemonster.com')),
    })

    expect(discovery.repositories).toEqual([])
    expect(discovery.renamed).toEqual([
      {
        checkout: '/home/wolfstar/sites/massivemonster.co',
        origin: 'wolfstar-project/massivemonster.co',
        current: 'wolfstar-project/massivemonster.com',
      },
    ])
    expect(discovery.unresolved).toEqual([])
  })

  it.each([
    ['rejects', () => Promise.reject(new Error('HTTP 502'))],
    // The CLI answers every failure, an outage included, with no repository.
    ['answers nothing', () => Promise.resolve(undefined)],
  ])('names a repository as unresolved when the read %s', async (_, readRepository) => {
    const discovery = await discoverUserRepositories({
      allowedOwners: ['nuxt-modules'],
      checkouts,
      installed: [],
      readRepository,
    })

    expect(discovery.repositories).toEqual([])
    expect(discovery.unresolved).toEqual(['nuxt-modules/sitemap'])
  })

  it('leaves the App in charge when it already reaches the current repository', async () => {
    expect(
      (
        await discoverUserRepositories({
          allowedOwners: ['wolfstar-project'],
          checkouts: [{ github: 'wolfstar-project/example', checkout: '/home/wolfstar/pkg/example' }],
          installed: [],
          readRepository: (github) => Promise.resolve(organizationRepository(github)),
        })
      ).repositories,
    ).toEqual([expect.objectContaining({ github: 'wolfstar-project/example' })])

    expect(
      (
        await discoverUserRepositories({
          allowedOwners: ['wolfstar-project'],
          checkouts: [{ github: 'wolfstar-project/example', checkout: '/home/wolfstar/pkg/example' }],
          installed: [installed],
          readRepository: (github) => Promise.resolve(organizationRepository(github)),
        })
      ).repositories,
    ).toEqual([])
  })

  it('leaves out a repository Wolfstar cannot read or that is archived', async () => {
    expect(
      (
        await discoverUserRepositories({
          allowedOwners: ['nuxt-modules'],
          checkouts,
          installed: [],
          readRepository: () => Promise.resolve(undefined),
        })
      ).repositories,
    ).toEqual([])

    expect(
      (
        await discoverUserRepositories({
          allowedOwners: ['nuxt-modules'],
          checkouts,
          installed: [],
          readRepository: (github) => Promise.resolve(organizationRepository(github, true)),
        })
      ).repositories,
    ).toEqual([])
  })

  it('leaves out a fork', async () => {
    expect(
      (
        await discoverUserRepositories({
          allowedOwners: ['nuxt-modules'],
          checkouts,
          installed: [],
          readRepository: (github) => Promise.resolve(organizationRepository(github, false, true)),
        })
      ).repositories,
    ).toEqual([])
  })

  it('maps as maintained, so the controller reviews without pushing', () => {
    const mappings = buildRepositoryMappings(
      [{ ...organizationRepository('nuxt-modules/sitemap'), authentication: 'user' }],
      [{ github: 'nuxt-modules/sitemap', checkout: '/home/wolfstar/pkg/sitemap' }],
      [],
      ['nuxt-modules'],
    )

    expect(mappings).toEqual([
      expect.objectContaining({
        github: 'nuxt-modules/sitemap',
        authentication: 'user',
        ownership: 'maintained',
        pullRequestReview: true,
        issueWork: false,
        conflictResolution: false,
      }),
    ])
  })
})

describe('createRoutedTokenProvider', () => {
  it('sends each repository to the credential that can reach it', async () => {
    const calls: string[] = []
    const provider = createRoutedTokenProvider({
      app: {
        getToken: (repository) => {
          calls.push(`app:${repository}`)
          return Promise.resolve(ok({ token: 'app-token', expiresAt: '2026-08-15T02:00:00.000Z' }))
        },
        invalidate: (repository) => calls.push(`app:invalidate:${repository}`),
      },
      user: {
        getToken: (repository) => {
          calls.push(`user:${repository}`)
          return Promise.resolve(ok({ token: 'user-token', expiresAt: '2026-08-15T02:00:00.000Z' }))
        },
        invalidate: (repository) => calls.push(`user:invalidate:${repository}`),
      },
      usesUserToken: (repository) => repository === 'nuxt-modules/sitemap',
    })

    await provider.getToken('wolfstar-project/example', 'read')
    await provider.getToken('nuxt-modules/sitemap', 'item_write')

    expect(calls).toEqual(['app:wolfstar-project/example', 'user:nuxt-modules/sitemap'])
  })
})

describe('createUserTokenProvider', () => {
  it('reuses one token read until it goes stale', async () => {
    let reads = 0
    let clock = Date.parse('2026-08-15T01:00:00.000Z')
    const provider = createUserTokenProvider({
      cacheMilliseconds: 300_000,
      now: () => new Date(clock),
      readToken: () => {
        reads += 1
        return Promise.resolve('gho_token\n')
      },
    })

    expect(await provider.getToken('nuxt-modules/sitemap', 'read')).toEqual(
      ok({
        token: 'gho_token',
        expiresAt: '2026-08-15T01:05:00.000Z',
      }),
    )
    await provider.getToken('nuxt-modules/sitemap', 'item_write')
    expect(reads).toBe(1)

    clock += 300_000
    await provider.getToken('nuxt-modules/sitemap', 'read')
    expect(reads).toBe(2)
  })

  it('reports a CLI that cannot answer', async () => {
    const provider = createUserTokenProvider({ readToken: () => Promise.reject(new Error('gh: command not found')) })

    expect(await provider.getToken('nuxt-modules/sitemap', 'read')).toEqual({
      _tag: 'Err',
      error: { repository: 'nuxt-modules/sitemap', message: 'gh: command not found' },
    })
  })
})

describe('createGitHubUserAccess', () => {
  it('identifies the account when its REST quota is exhausted', async () => {
    const access = createGitHubUserAccess({
      run: (args) =>
        args[1] === 'graphql' ? Promise.resolve('h-z') : Promise.reject(new Error('REST API rate limit exceeded')),
    })

    expect(await access.login()).toBe('h-z')
  })

  it('reads a repository when its REST quota is exhausted', async () => {
    const access = createGitHubUserAccess({
      run: (args) => {
        if (args[1] !== 'graphql') return Promise.reject(new Error('REST API rate limit exceeded'))
        return Promise.resolve(
          JSON.stringify({
            github: 'nuxt-modules/sitemap',
            defaultBranch: 'main',
            archived: false,
            fork: false,
            topics: [],
            owner: { login: 'nuxt-modules', type: 'Organization' },
          }),
        )
      },
    })

    expect(await access.readRepository('nuxt-modules/sitemap')).toEqual(
      expect.objectContaining({
        github: 'nuxt-modules/sitemap',
        defaultBranch: 'main',
        fork: false,
      }),
    )
  })

  it('leaves an inaccessible repository untracked', async () => {
    const access = createGitHubUserAccess({ run: () => Promise.resolve('null') })

    expect(await access.readRepository('nuxt-modules/missing')).toBeUndefined()
  })
})
