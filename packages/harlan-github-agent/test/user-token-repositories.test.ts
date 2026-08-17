import type { InstalledRepository } from '../src/repository-discovery.ts'
import { describe, expect, it } from 'vitest'
import { createRoutedTokenProvider, createUserTokenProvider } from '../src/github-auth.ts'
import { createGitHubUserAccess } from '../src/github-user-access.ts'
import { buildRepositoryMappings, discoverUserRepositories } from '../src/repository-discovery.ts'
import { ok } from '../src/result.ts'

const installed: InstalledRepository = {
  github: 'harlan-zw/example',
  defaultBranch: 'main',
  archived: false,
  topics: [],
  authentication: 'app',
  owner: { login: 'harlan-zw', type: 'User' },
}

function organizationRepository(github: string, archived = false) {
  return {
    github,
    defaultBranch: 'main',
    archived,
    topics: [],
    owner: { login: github.split('/')[0] as string, type: 'Organization' as const },
  }
}

describe('discoverUserRepositories', () => {
  const checkouts = [
    { github: 'harlan-zw/example', checkout: '/home/harlan/pkg/example' },
    { github: 'nuxt-modules/sitemap', checkout: '/home/harlan/pkg/sitemap' },
    { github: 'nuxt-modules/sitemap', checkout: '/home/harlan/pkg/sitemap.fix-one' },
    { github: 'someone-else/tool', checkout: '/home/harlan/pkg/tool' },
  ]

  it('adds a maintained repository the App cannot reach', async () => {
    const read: string[] = []
    const repositories = await discoverUserRepositories({
      allowedOwners: ['harlan-zw', 'nuxt-modules'],
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

  it('leaves out a checkout whose remote points at a renamed repository', async () => {
    // GitHub redirects the old name, so the read answers with the current one.
    expect(await discoverUserRepositories({
      allowedOwners: ['harlan-zw', 'nuxt-modules'],
      checkouts: [{ github: 'harlan-zw/massivemonster.co', checkout: '/home/harlan/sites/massivemonster.co' }],
      installed: [],
      readRepository: () => Promise.resolve(organizationRepository('harlan-zw/massivemonster.com')),
    })).toEqual([])
  })

  it('leaves the App in charge when it already reaches the current repository', async () => {
    expect(await discoverUserRepositories({
      allowedOwners: ['harlan-zw'],
      checkouts: [{ github: 'harlan-zw/example', checkout: '/home/harlan/pkg/example' }],
      installed: [],
      readRepository: github => Promise.resolve(organizationRepository(github)),
    })).toEqual([expect.objectContaining({ github: 'harlan-zw/example' })])

    expect(await discoverUserRepositories({
      allowedOwners: ['harlan-zw'],
      checkouts: [{ github: 'harlan-zw/example', checkout: '/home/harlan/pkg/example' }],
      installed: [installed],
      readRepository: github => Promise.resolve(organizationRepository(github)),
    })).toEqual([])
  })

  it('leaves out a repository Harlan cannot read or that is archived', async () => {
    expect(await discoverUserRepositories({
      allowedOwners: ['nuxt-modules'],
      checkouts,
      installed: [],
      readRepository: () => Promise.resolve(undefined),
    })).toEqual([])

    expect(await discoverUserRepositories({
      allowedOwners: ['nuxt-modules'],
      checkouts,
      installed: [],
      readRepository: github => Promise.resolve(organizationRepository(github, true)),
    })).toEqual([])
  })

  it('maps as maintained, so the controller reviews without pushing', () => {
    const mappings = buildRepositoryMappings(
      [{ ...organizationRepository('nuxt-modules/sitemap'), authentication: 'user' }],
      [{ github: 'nuxt-modules/sitemap', checkout: '/home/harlan/pkg/sitemap' }],
      [],
      ['nuxt-modules'],
    )

    expect(mappings).toEqual([expect.objectContaining({
      github: 'nuxt-modules/sitemap',
      authentication: 'user',
      ownership: 'maintained',
      pullRequestReview: true,
      issueWork: false,
      conflictResolution: false,
    })])
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
        invalidate: repository => calls.push(`app:invalidate:${repository}`),
      },
      user: {
        getToken: (repository) => {
          calls.push(`user:${repository}`)
          return Promise.resolve(ok({ token: 'user-token', expiresAt: '2026-08-15T02:00:00.000Z' }))
        },
        invalidate: repository => calls.push(`user:invalidate:${repository}`),
      },
      usesUserToken: repository => repository === 'nuxt-modules/sitemap',
    })

    await provider.getToken('harlan-zw/example', 'read')
    await provider.getToken('nuxt-modules/sitemap', 'issues_write')

    expect(calls).toEqual(['app:harlan-zw/example', 'user:nuxt-modules/sitemap'])
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

    expect(await provider.getToken('nuxt-modules/sitemap', 'read')).toEqual(ok({
      token: 'gho_token',
      expiresAt: '2026-08-15T01:05:00.000Z',
    }))
    await provider.getToken('nuxt-modules/sitemap', 'issues_write')
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
  it('reads one repository through the GitHub CLI', async () => {
    const commands: string[][] = []
    const access = createGitHubUserAccess({
      run: (args) => {
        commands.push(args)
        return Promise.resolve(JSON.stringify({
          github: 'nuxt-modules/sitemap',
          defaultBranch: 'main',
          archived: false,
          topics: [],
          owner: { login: 'nuxt-modules', type: 'Organization' },
        }))
      },
    })

    expect(await access.readRepository('nuxt-modules/sitemap')).toEqual(expect.objectContaining({
      github: 'nuxt-modules/sitemap',
      defaultBranch: 'main',
    }))
    expect(commands[0]?.slice(0, 2)).toEqual(['api', 'repos/nuxt-modules/sitemap'])
  })
})
