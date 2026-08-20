import type { InstalledRepository } from '../src/repository-discovery.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRepositoryMappings, discoverLocalCheckouts, installedWithoutCheckout, isAllowedRepository } from '../src/repository-discovery.ts'
import { repositoryMapping } from './fixtures.ts'

const temporaryDirectories: string[] = []

afterEach(() => temporaryDirectories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

describe('installedWithoutCheckout', () => {
  const installed = [
    { github: 'harlan-zw/example', defaultBranch: 'main', archived: false, topics: [], authentication: 'app' as const, owner: { login: 'harlan-zw', type: 'User' as const } },
    { github: 'harlan-zw/unlighthouse.dev', defaultBranch: 'main', archived: false, topics: [], authentication: 'app' as const, owner: { login: 'harlan-zw', type: 'User' as const } },
    { github: 'harlan-zw/retired', defaultBranch: 'main', archived: true, topics: [], authentication: 'app' as const, owner: { login: 'harlan-zw', type: 'User' as const } },
    { github: 'someone-else/tool', defaultBranch: 'main', archived: false, topics: [], authentication: 'app' as const, owner: { login: 'someone-else', type: 'User' as const } },
  ]

  it('names every granted repository that no agent can see', () => {
    expect(installedWithoutCheckout(installed, [{ github: 'harlan-zw/example', checkout: '/home/harlan/pkg/example' }], ['harlan-zw']))
      .toEqual(['harlan-zw/unlighthouse.dev'])
  })

  it('says nothing once every granted repository has a checkout', () => {
    expect(installedWithoutCheckout(installed, [
      { github: 'harlan-zw/example', checkout: '/home/harlan/pkg/example' },
      { github: 'harlan-zw/unlighthouse.dev', checkout: '/home/harlan/sites/unlighthouse.dev' },
    ], ['harlan-zw'])).toEqual([])
  })
})

describe('repository discovery', () => {
  it('ignores temporary worktrees beside the canonical checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harlan-discovery-'))
    temporaryDirectories.push(root)
    const checkout = join(root, 'example')
    execFileSync('git', ['init', checkout])
    execFileSync('git', ['-C', checkout, 'config', 'user.name', 'Test Agent'])
    execFileSync('git', ['-C', checkout, 'config', 'user.email', 'agent@example.com'])
    execFileSync('git', ['-C', checkout, 'remote', 'add', 'origin', 'git@github.com:harlan-zw/example.git'])
    writeFileSync(join(checkout, 'README.md'), 'test\n')
    execFileSync('git', ['-C', checkout, 'add', 'README.md'])
    execFileSync('git', ['-C', checkout, 'commit', '-m', 'test'])
    execFileSync('wt', ['-C', checkout, 'switch', '--create', 'fix/review', '--yes'])

    expect(await discoverLocalCheckouts([root])).toEqual([{
      github: 'harlan-zw/example',
      checkout,
    }])
  })

  it('maps only explicitly allowed installation owners with trusted checkouts', () => {
    const mappings = buildRepositoryMappings([
      {
        github: 'harlan-zw/example',
        defaultBranch: 'main',
        archived: false,
        topics: [],
        authentication: 'app' as const,
        owner: { login: 'harlan-zw', type: 'User' },
      },
      {
        github: 'skilld-dev/shared',
        defaultBranch: 'main',
        archived: false,
        topics: ['harlan-agent-issues', 'harlan-agent-conflicts'],
        authentication: 'app' as const,
        owner: { login: 'skilld-dev', type: 'Organization' },
      },
      {
        github: 'harlan-zw/remote-only',
        defaultBranch: 'main',
        archived: false,
        topics: [],
        authentication: 'app' as const,
        owner: { login: 'harlan-zw', type: 'User' },
      },
    ], [
      { github: 'harlan-zw/example', checkout: '/home/harlan/pkg/example' },
      { github: 'skilld-dev/shared', checkout: '/home/harlan/pkg/shared' },
    ], [], ['harlan-zw'])

    expect(mappings).toEqual([
      expect.objectContaining({
        github: 'harlan-zw/example',
        checkout: '/home/harlan/pkg/example',
        ownership: 'owned',
        issueWork: true,
        pullRequestReview: true,
        pullRequestConformance: true,
        conflictResolution: true,
      }),
    ])
    expect(mappings[0]?.writablePullRequestAuthors).toEqual(['harlan-zw', 'harlan-github-agent[bot]'])
  })

  it('admits one repository without admitting its owner', () => {
    const allowed = ['harlan-zw', 'nuxt/scripts']

    expect(isAllowedRepository('nuxt/scripts', allowed)).toBe(true)
    expect(isAllowedRepository('NUXT/Scripts', allowed)).toBe(true)
    expect(isAllowedRepository('harlan-zw/mdream', allowed)).toBe(true)
    expect(isAllowedRepository('nuxt/nuxt', allowed)).toBe(false)
    expect(isAllowedRepository('nuxt/nuxt.com', allowed)).toBe(false)
    expect(isAllowedRepository('nuxt/scripts-other', allowed)).toBe(false)
  })

  it('maps one allowed repository and none of its neighbours', () => {
    // Naming the owner used to admit every repository in it that had a local
    // checkout, which is how four Nuxt repositories were commented on at once.
    const nuxtRepository = (name: string): InstalledRepository => ({
      github: `nuxt/${name}`,
      defaultBranch: 'main',
      archived: false,
      topics: [],
      authentication: 'user',
      owner: { login: 'nuxt', type: 'Organization' },
    })
    const mappings = buildRepositoryMappings(
      ['scripts', 'nuxt', 'nuxt.com', 'cli'].map(nuxtRepository),
      ['scripts', 'nuxt', 'nuxt.com', 'cli'].map(name => ({ github: `nuxt/${name}`, checkout: `/home/harlan/pkg/${name}` })),
      [],
      ['nuxt/scripts'],
    )

    expect(mappings.map(mapping => mapping.github)).toEqual(['nuxt/scripts'])
  })

  it('keeps the discovered credential when explicit policy claims another', () => {
    // An organization that refuses the App leaves Harlan's own token as the only
    // way in. Policy that declared an installation sent every write to a token
    // that does not exist.
    const override = repositoryMapping({ github: 'nuxt/scripts', ownership: 'owned', issueWork: true })
    const mappings = buildRepositoryMappings([{
      github: 'nuxt/scripts',
      defaultBranch: 'main',
      archived: false,
      topics: [],
      authentication: 'user' as const,
      owner: { login: 'nuxt', type: 'Organization' },
    }], [{ github: 'nuxt/scripts', checkout: '/home/harlan/pkg/nuxt-scripts' }], [override], ['nuxt'])

    expect(mappings[0]).toEqual(expect.objectContaining({
      github: 'nuxt/scripts',
      authentication: 'user',
      ownership: 'owned',
      issueWork: true,
    }))
  })

  it('applies explicit policy without trusting its stale path or default branch', () => {
    const override = repositoryMapping({
      checkout: '/wrong/path',
      defaultBranch: 'master',
      issueWork: false,
    })
    const mappings = buildRepositoryMappings([{
      github: 'harlan-zw/example',
      defaultBranch: 'main',
      archived: false,
      topics: [],
      authentication: 'app' as const,
      owner: { login: 'harlan-zw', type: 'User' },
    }], [{ github: 'harlan-zw/example', checkout: '/home/harlan/pkg/example' }], [override], ['harlan-zw'])

    expect(mappings[0]).toEqual(expect.objectContaining({
      checkout: '/home/harlan/pkg/example',
      defaultBranch: 'main',
      issueWork: false,
    }))
  })

  it('disables archived repositories', () => {
    const mappings = buildRepositoryMappings([{
      github: 'harlan-zw/example',
      defaultBranch: 'main',
      archived: true,
      topics: [],
      authentication: 'app' as const,
      owner: { login: 'harlan-zw', type: 'User' },
    }], [{ github: 'harlan-zw/example', checkout: '/home/harlan/pkg/example' }], [], ['harlan-zw'])

    expect(mappings[0]?.enabled).toBe(false)
  })
})
