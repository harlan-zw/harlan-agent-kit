import type { InstalledRepository } from '../src/repository-discovery.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildRepositoryMappings,
  discoverLocalCheckouts,
  installedWithoutCheckout,
  isAllowedRepository,
} from '../src/repository-discovery.ts'
import { canRepairPullRequestHead } from '../src/repository-policy.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const temporaryDirectories: string[] = []

afterEach(() => temporaryDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))

describe('installedWithoutCheckout', () => {
  const installed = [
    {
      github: 'wolfstar-project/example',
      defaultBranch: 'main',
      archived: false,
      fork: false,
      topics: [],
      authentication: 'app' as const,
      owner: { login: 'wolfstar-project', type: 'User' as const },
    },
    {
      github: 'wolfstar-project/unlighthouse.dev',
      defaultBranch: 'main',
      archived: false,
      fork: false,
      topics: [],
      authentication: 'app' as const,
      owner: { login: 'wolfstar-project', type: 'User' as const },
    },
    {
      github: 'wolfstar-project/retired',
      defaultBranch: 'main',
      archived: true,
      fork: false,
      topics: [],
      authentication: 'app' as const,
      owner: { login: 'wolfstar-project', type: 'User' as const },
    },
    {
      github: 'someone-else/tool',
      defaultBranch: 'main',
      archived: false,
      fork: false,
      topics: [],
      authentication: 'app' as const,
      owner: { login: 'someone-else', type: 'User' as const },
    },
  ]

  it('names every granted repository that no agent can see', () => {
    expect(
      installedWithoutCheckout(
        installed,
        [{ github: 'wolfstar-project/example', checkout: '/home/wolfstar/pkg/example' }],
        ['wolfstar-project'],
      ),
    ).toEqual(['wolfstar-project/unlighthouse.dev'])
  })

  it('says nothing once every granted repository has a checkout', () => {
    expect(
      installedWithoutCheckout(
        installed,
        [
          { github: 'wolfstar-project/example', checkout: '/home/wolfstar/pkg/example' },
          { github: 'wolfstar-project/unlighthouse.dev', checkout: '/home/wolfstar/sites/unlighthouse.dev' },
        ],
        ['wolfstar-project'],
      ),
    ).toEqual([])
  })
})

describe('repository discovery', () => {
  it('inherits release policy only for stable public packages with a tag workflow', () => {
    const root = mkdtempSync(join(tmpdir(), 'wolfstar-release-defaults-'))
    temporaryDirectories.push(root)
    const checkout = join(root, 'example')
    mkdirSync(join(checkout, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'example', version: '1.2.3' }))
    writeFileSync(join(checkout, '.github', 'workflows', 'release.yml'), 'on:\n  push:\n    tags: ["v*"]\n')
    const installed = [
      {
        github: 'wolfstar-project/example',
        defaultBranch: 'main',
        archived: false,
        fork: false,
        topics: [],
        authentication: 'app' as const,
        owner: { login: 'wolfstar-project', type: 'User' as const },
      },
    ]
    const defaults = {
      owner: 'wolfstar-project',
      checkoutRoot: root,
      policy: {
        manifest: 'package.json',
        versionFiles: ['package.json'],
        tagPrefix: 'v',
        workflow: 'release.yml',
        checks: 'all' as const,
        credential: { _tag: 'Repository' as const },
      },
    }
    const map = (overrides: Parameters<typeof buildRepositoryMappings>[2] = []) =>
      buildRepositoryMappings(
        installed,
        [{ github: 'wolfstar-project/example', checkout }],
        overrides,
        ['wolfstar-project'],
        defaults,
      )

    expect(map()[0]?.release).toEqual(defaults.policy)
    expect(
      map([{ ...repositoryMapping(), github: 'wolfstar-project/example', release: undefined }])[0]?.release,
    ).toBeUndefined()
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'example', version: '1.2.3', private: true }))
    expect(map()[0]?.release).toBeUndefined()
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'example', version: '1.2.3' }))
    writeFileSync(join(checkout, '.github', 'workflows', 'release.yml'), 'on:\n  push:\n    branches: [main]\n')
    expect(map()[0]?.release).toBeUndefined()
  })

  it('ignores temporary worktrees beside the canonical checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wolfstar-discovery-'))
    temporaryDirectories.push(root)
    const checkout = join(root, 'example')
    execFileSync('git', ['init', checkout])
    execFileSync('git', ['-C', checkout, 'config', 'user.name', 'Test Agent'])
    execFileSync('git', ['-C', checkout, 'config', 'user.email', 'agent@example.com'])
    execFileSync('git', ['-C', checkout, 'remote', 'add', 'origin', 'git@github.com:wolfstar-project/example.git'])
    writeFileSync(join(checkout, 'README.md'), 'test\n')
    execFileSync('git', ['-C', checkout, 'add', 'README.md'])
    execFileSync('git', ['-C', checkout, 'commit', '-m', 'test'])
    // Stands in for the service, so Worktrunk hooks read the same caller it does.
    execFileSync('wt', ['-C', checkout, 'switch', '--create', 'fix/review', '--yes'], {
      env: { ...process.env, WOLFSTAR_GITHUB_AGENT: '1' },
    })

    expect(await discoverLocalCheckouts([root])).toEqual([
      {
        github: 'wolfstar-project/example',
        checkout,
      },
    ])
  })

  it('maps only explicitly allowed installation owners with trusted checkouts', () => {
    const mappings = buildRepositoryMappings(
      [
        {
          github: 'wolfstar-project/example',
          defaultBranch: 'main',
          archived: false,
          fork: false,
          topics: [],
          authentication: 'app' as const,
          owner: { login: 'wolfstar-project', type: 'User' },
        },
        {
          github: 'skilld-dev/shared',
          defaultBranch: 'main',
          archived: false,
          fork: false,
          topics: ['wolfstar-agent-issues', 'wolfstar-agent-conflicts'],
          authentication: 'app' as const,
          owner: { login: 'skilld-dev', type: 'Organization' },
        },
        {
          github: 'wolfstar-project/remote-only',
          defaultBranch: 'main',
          archived: false,
          fork: false,
          topics: [],
          authentication: 'app' as const,
          owner: { login: 'wolfstar-project', type: 'User' },
        },
      ],
      [
        { github: 'wolfstar-project/example', checkout: '/home/wolfstar/pkg/example' },
        { github: 'skilld-dev/shared', checkout: '/home/wolfstar/pkg/shared' },
      ],
      [],
      ['wolfstar-project'],
    )

    expect(mappings).toEqual([
      expect.objectContaining({
        github: 'wolfstar-project/example',
        checkout: '/home/wolfstar/pkg/example',
        ownership: 'owned',
        issueWork: true,
        pullRequestReview: true,
        conflictResolution: true,
      }),
    ])
    expect(mappings[0]?.writablePullRequestAuthors).toEqual(['wolfstar-project', 'wolfstar-github-agent[bot]'])
  })

  it('does not map a fork', () => {
    const mappings = buildRepositoryMappings(
      [
        {
          github: 'wolfstar-project/skills',
          defaultBranch: 'main',
          archived: false,
          fork: true,
          topics: [],
          authentication: 'app' as const,
          owner: { login: 'wolfstar-project', type: 'User' },
        },
      ],
      [{ github: 'wolfstar-project/skills', checkout: '/home/wolfstar/pkg/skills' }],
      [],
      ['wolfstar-project'],
    )

    expect(mappings).toEqual([])
  })

  it('admits one repository without admitting its owner', () => {
    const allowed = ['wolfstar-project', 'nuxt/scripts']

    expect(isAllowedRepository('nuxt/scripts', allowed)).toBe(true)
    expect(isAllowedRepository('NUXT/Scripts', allowed)).toBe(true)
    expect(isAllowedRepository('wolfstar-project/mdream', allowed)).toBe(true)
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
      fork: false,
      topics: [],
      authentication: 'user',
      owner: { login: 'nuxt', type: 'Organization' },
    })
    const mappings = buildRepositoryMappings(
      ['scripts', 'nuxt', 'nuxt.com', 'cli'].map(nuxtRepository),
      ['scripts', 'nuxt', 'nuxt.com', 'cli'].map((name) => ({
        github: `nuxt/${name}`,
        checkout: `/home/wolfstar/pkg/${name}`,
      })),
      [],
      ['nuxt/scripts'],
    )

    expect(mappings.map((mapping) => mapping.github)).toEqual(['nuxt/scripts'])
  })

  it('keeps the discovered credential when explicit policy claims another', () => {
    // An organization that refuses the App leaves Wolfstar's own token as the only
    // way in. Policy that declared an installation sent every write to a token
    // that does not exist.
    const override = repositoryMapping({ github: 'nuxt/scripts', ownership: 'owned', issueWork: true })
    const mappings = buildRepositoryMappings(
      [
        {
          github: 'nuxt/scripts',
          defaultBranch: 'main',
          archived: false,
          fork: false,
          topics: [],
          authentication: 'user' as const,
          owner: { login: 'nuxt', type: 'Organization' },
        },
      ],
      [{ github: 'nuxt/scripts', checkout: '/home/wolfstar/pkg/nuxt-scripts' }],
      [override],
      ['nuxt'],
    )

    expect(mappings[0]).toEqual(
      expect.objectContaining({
        github: 'nuxt/scripts',
        authentication: 'user',
        ownership: 'owned',
        issueWork: true,
      }),
    )
  })

  it('applies explicit policy without trusting its stale path or default branch', () => {
    const override = repositoryMapping({
      checkout: '/wrong/path',
      defaultBranch: 'master',
      issueWork: false,
    })
    const mappings = buildRepositoryMappings(
      [
        {
          github: 'wolfstar-project/example',
          defaultBranch: 'main',
          archived: false,
          fork: false,
          topics: [],
          authentication: 'app' as const,
          owner: { login: 'wolfstar-project', type: 'User' },
        },
      ],
      [{ github: 'wolfstar-project/example', checkout: '/home/wolfstar/pkg/example' }],
      [override],
      ['wolfstar-project'],
    )

    expect(mappings[0]).toEqual(
      expect.objectContaining({
        checkout: '/home/wolfstar/pkg/example',
        defaultBranch: 'main',
        issueWork: false,
      }),
    )
  })

  it('disables archived repositories', () => {
    const mappings = buildRepositoryMappings(
      [
        {
          github: 'wolfstar-project/example',
          defaultBranch: 'main',
          archived: true,
          fork: false,
          topics: [],
          authentication: 'app' as const,
          owner: { login: 'wolfstar-project', type: 'User' },
        },
      ],
      [{ github: 'wolfstar-project/example', checkout: '/home/wolfstar/pkg/example' }],
      [],
      ['wolfstar-project'],
    )

    expect(mappings[0]?.enabled).toBe(false)
  })

  it('lets the controller repair a CI branch without explicit policy', () => {
    const mappings = buildRepositoryMappings(
      [
        {
          github: 'wolfstar-project/example',
          defaultBranch: 'main',
          archived: false,
          fork: false,
          topics: [],
          authentication: 'app' as const,
          owner: { login: 'wolfstar-project', type: 'User' },
        },
      ],
      [{ github: 'wolfstar-project/example', checkout: '/home/wolfstar/pkg/example' }],
      [],
      ['wolfstar-project'],
    )

    expect(
      canRepairPullRequestHead(
        mappings[0]!,
        pullRequestItem({
          headRef: 'ci/self-hosted-runners',
        }),
      ),
    ).toBe(true)
  })
})
