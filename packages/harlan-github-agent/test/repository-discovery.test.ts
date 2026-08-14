import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRepositoryMappings, discoverLocalCheckouts } from '../src/repository-discovery.ts'
import { repositoryMapping } from './fixtures.ts'

const temporaryDirectories: string[] = []

afterEach(() => temporaryDirectories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))

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
        owner: { login: 'harlan-zw', type: 'User' },
      },
      {
        github: 'skilld-dev/shared',
        defaultBranch: 'main',
        archived: false,
        topics: ['harlan-agent-issues', 'harlan-agent-conflicts'],
        owner: { login: 'skilld-dev', type: 'Organization' },
      },
      {
        github: 'harlan-zw/remote-only',
        defaultBranch: 'main',
        archived: false,
        topics: [],
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
        writablePullRequestAuthors: ['harlan-zw'],
        issueWork: true,
        pullRequestReview: true,
        pullRequestConformance: true,
        conflictResolution: true,
      }),
    ])
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
      owner: { login: 'harlan-zw', type: 'User' },
    }], [{ github: 'harlan-zw/example', checkout: '/home/harlan/pkg/example' }], [], ['harlan-zw'])

    expect(mappings[0]?.enabled).toBe(false)
  })
})
