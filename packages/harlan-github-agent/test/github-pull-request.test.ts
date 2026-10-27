import type { Octokit } from 'octokit'
import { describe, expect, it } from 'vitest'
import { BASELINE_REPAIR_LABEL_SPEC } from '../src/baseline-repair-state.ts'
import { createGitHubPullRequestPublisher } from '../src/github.ts'
import { err, ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

describe('gitHub pull request publication', () => {
  it('opens a stacked pull request against another pull request head branch', async () => {
    let created: { base: string, head: string } | undefined
    let listed: { base: string } | undefined
    const publisher = createGitHubPullRequestPublisher({
      createClient: () => ({
        rest: {
          pulls: {
            create: (input: { base: string, head: string }) => {
              created = input
              return Promise.resolve({ data: { html_url: 'https://github.com/harlan-zw/example/pull/31', number: 31, head: { sha: 'abc123' } } })
            },
            list: (input: { base: string }) => {
              listed = input
              return Promise.resolve({ data: [] })
            },
          },
        },
      }) as unknown as Octokit,
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T02:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })

    await publisher.ensurePullRequest({
      repository: repositoryMapping(),
      baseRef: 'fix/baseline-ci-abcdef012345',
      headRef: 'fix/issue-30',
      expectedHeadSha: 'abc123',
      title: 'fix: broken thing',
      body: 'Closes #30.',
    })

    expect(listed).toEqual(expect.objectContaining({ base: 'fix/baseline-ci-abcdef012345' }))
    expect(created).toEqual(expect.objectContaining({ base: 'fix/baseline-ci-abcdef012345', head: 'fix/issue-30' }))
  })

  it('opens issue work ready for review', async () => {
    let draft: boolean | undefined
    const publisher = createGitHubPullRequestPublisher({
      createClient: () => ({
        rest: {
          pulls: {
            create: (input: { draft: boolean }) => {
              draft = input.draft
              return Promise.resolve({ data: { html_url: 'https://github.com/harlan-zw/example/pull/31', number: 31, head: { sha: 'abc123' } } })
            },
            list: () => Promise.resolve({ data: [] }),
          },
        },
      }) as unknown as Octokit,
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T02:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })

    const result = await publisher.ensurePullRequest({
      repository: repositoryMapping(),
      baseRef: 'main',
      headRef: 'fix/issue-30',
      expectedHeadSha: 'abc123',
      title: 'fix: broken thing',
      body: 'Closes #30.',
    })

    expect(draft).toBe(false)
    expect(result).toEqual(ok({ number: 31, url: 'https://github.com/harlan-zw/example/pull/31', diagram: { _tag: 'None' } }))
  })

  it('marks a Baseline repair pull request on GitHub', async () => {
    const createdLabels: string[] = []
    const appliedLabels: string[] = []
    const publisher = createGitHubPullRequestPublisher({
      createClient: () => ({
        rest: {
          issues: {
            addLabels: (input: { labels: string[] }) => {
              appliedLabels.push(...input.labels)
              return Promise.resolve({ data: [] })
            },
            createLabel: (input: { name: string }) => {
              createdLabels.push(input.name)
              return Promise.resolve({ data: {} })
            },
          },
          pulls: {
            create: () => Promise.resolve({ data: { html_url: 'https://github.com/harlan-zw/example/pull/31', number: 31, head: { sha: 'abc123' } } }),
            list: () => Promise.resolve({ data: [] }),
          },
        },
      }) as unknown as Octokit,
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T02:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })

    await publisher.ensurePullRequest({
      repository: repositoryMapping(),
      baseRef: 'main',
      headRef: 'fix/baseline-ci-abcdef012345',
      expectedHeadSha: 'abc123',
      title: 'fix: repair default branch CI',
      body: 'Repairs CI.',
      labels: [BASELINE_REPAIR_LABEL_SPEC],
    })

    expect(createdLabels).toEqual(['harlan-agent-baseline-repair'])
    expect(appliedLabels).toEqual(['harlan-agent-baseline-repair'])
  })

  it('recovers a Review request after the pull request was created and its label write failed', async () => {
    const labels: string[][] = []
    let created = 0
    let exists = false
    const pullRequest = { html_url: 'https://github.com/harlan-zw/example/pull/31', number: 31, head: { sha: 'abc123' }, draft: false }
    const publisher = createGitHubPullRequestPublisher({
      createClient: () => ({ rest: {
        pulls: {
          list: async () => ({ data: exists ? [pullRequest] : [] }),
          create: async () => {
            created++
            exists = true
            return { data: pullRequest }
          },
        },
        issues: {
          createLabel: async () => ({ data: {} }),
          addLabels: async (input: { labels: string[] }) => {
            labels.push(input.labels)
            if (labels.length === 1)
              throw new Error('The label write failed.')
            return { data: [] }
          },
        },
      } }) as unknown as Octokit,
      tokens: { getToken: async () => ok({ token: 'token', expiresAt: '2126-01-01T00:00:00Z' }), invalidate: () => undefined },
    })
    const request = {
      repository: repositoryMapping(),
      baseRef: 'main',
      headRef: 'fix/issue-30',
      expectedHeadSha: 'abc123',
      title: 'fix: correct a defect',
      body: 'Corrects a defect.',
      labels: [{ name: 'harlan-agent-review', color: '8250df', description: 'Approve automated review for this head.' }],
    }

    expect(await publisher.ensurePullRequest(request)).toEqual(err({ repository: request.repository.github, message: 'The label write failed.' }))
    expect(await publisher.ensurePullRequest(request)).toEqual(ok({ number: 31, url: pullRequest.html_url, diagram: { _tag: 'None' } }))
    expect(created).toBe(1)
    expect(labels).toEqual([['harlan-agent-review'], ['harlan-agent-review']])
  })

  it.each([
    ['an existing draft', [{ number: 31, html_url: 'https://github.com/harlan-zw/example/pull/31', head: { sha: 'abc123' }, draft: true }], 'abc123'],
    ['a changed existing branch', [{ number: 31, html_url: 'https://github.com/harlan-zw/example/pull/31', head: { sha: 'changed' }, draft: false }], 'changed'],
    ['a changed newly created branch', [], 'changed'],
  ])('does not approve %s', async (_scenario, existing, createdHead) => {
    const labels: string[][] = []
    const publisher = createGitHubPullRequestPublisher({
      createClient: () => ({ rest: {
        pulls: {
          list: async () => ({ data: existing }),
          create: async () => ({ data: { number: 31, html_url: 'https://github.com/harlan-zw/example/pull/31', head: { sha: createdHead }, draft: false } }),
        },
        issues: {
          createLabel: async () => ({ data: {} }),
          addLabels: async (input: { labels: string[] }) => {
            labels.push(input.labels)
            return { data: [] }
          },
        },
      } }) as unknown as Octokit,
      tokens: { getToken: async () => ok({ token: 'token', expiresAt: '2126-01-01T00:00:00Z' }), invalidate: () => undefined },
    })

    const result = await publisher.ensurePullRequest({
      repository: repositoryMapping(),
      baseRef: 'main',
      headRef: 'fix/issue-30',
      expectedHeadSha: 'abc123',
      title: 'fix: correct a defect',
      body: 'Corrects a defect.',
      labels: [{ name: 'harlan-agent-review', color: '8250df', description: 'Approve automated review for this head.' }],
    })

    expect(result._tag).toBe('Err')
    expect(labels).toEqual([])
  })
})

describe('pull request diagram attachment', () => {
  const disclosure = '> 🤖 AI disclosure: [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) modified this description.'
  const body = `### 📚 Description\n\nWhy the change exists.\n\n${disclosure}`
  const diagram = { svg: '<svg/>', alt: 'The handler reads through the cache' }

  function publisher(
    uploadAsset: ((upload: { name: string, repositoryId: number }) => Promise<ReturnType<typeof ok<string>> | ReturnType<typeof err<string>>>) | undefined,
    onCreate: (input: { body: string }) => void,
    getRepository: () => Promise<unknown> = () => Promise.resolve({ data: { id: 7 } }),
  ) {
    return createGitHubPullRequestPublisher({
      createClient: () => ({
        rest: {
          repos: { get: getRepository },
          pulls: {
            create: (input: { body: string }) => {
              onCreate(input)
              return Promise.resolve({ data: { html_url: 'https://github.com/harlan-zw/example/pull/31', number: 31, head: { sha: 'abc123' } } })
            },
            list: () => Promise.resolve({ data: [] }),
          },
        },
      }) as unknown as Octokit,
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T02:00:00.000Z' })),
        invalidate: () => undefined,
      },
      ...(uploadAsset === undefined ? {} : { uploadAsset }),
    })
  }

  it('uploads the picture and puts it above the disclosure', async () => {
    let created = ''
    let uploaded: { name: string, repositoryId: number } | undefined
    const result = await publisher((upload) => {
      uploaded = upload
      return Promise.resolve(ok('https://github.com/user-attachments/assets/abc'))
    }, input => created = input.body).ensurePullRequest({
      repository: repositoryMapping(),
      baseRef: 'main',
      headRef: 'fix/issue-30',
      expectedHeadSha: 'abc123',
      title: 'fix: broken thing',
      body,
      diagram,
    })

    expect(uploaded).toEqual(expect.objectContaining({ name: 'pr-lens-fix-issue-30.svg', repositoryId: 7 }))
    expect(created).toBe(`### 📚 Description\n\nWhy the change exists.\n\n![The handler reads through the cache](https://github.com/user-attachments/assets/abc)\n\n${disclosure}`)
    expect(result).toEqual(ok(expect.objectContaining({ diagram: { _tag: 'Attached', url: 'https://github.com/user-attachments/assets/abc' } })))
  })

  it('publishes the body as written when the upload fails, and says why', async () => {
    let created = ''
    const result = await publisher(() => Promise.resolve(err('GitHub refused the asset upload: HTTP 404.')), input => created = input.body).ensurePullRequest({
      repository: repositoryMapping(),
      baseRef: 'main',
      headRef: 'fix/issue-30',
      expectedHeadSha: 'abc123',
      title: 'fix: broken thing',
      body,
      diagram,
    })

    expect(created).toBe(body)
    expect(result).toEqual(ok(expect.objectContaining({ diagram: { _tag: 'Skipped', reason: 'GitHub refused the asset upload: HTTP 404.' } })))
  })

  it('publishes the body as written when the repository read for the upload fails, and says why', async () => {
    let created = ''
    const result = await publisher(
      () => Promise.resolve(ok('https://github.com/user-attachments/assets/abc')),
      input => created = input.body,
      () => Promise.reject(new Error('getaddrinfo EAI_AGAIN api.github.com')),
    ).ensurePullRequest({
      repository: repositoryMapping(),
      baseRef: 'main',
      headRef: 'fix/issue-30',
      expectedHeadSha: 'abc123',
      title: 'fix: broken thing',
      body,
      diagram,
    })

    expect(created).toBe(body)
    expect(result).toEqual(ok(expect.objectContaining({ diagram: { _tag: 'Skipped', reason: expect.stringContaining('EAI_AGAIN') } })))
  })

  it('skips the picture with a reason when no uploader is configured', async () => {
    const result = await publisher(undefined, () => undefined).ensurePullRequest({
      repository: repositoryMapping(),
      baseRef: 'main',
      headRef: 'fix/issue-30',
      expectedHeadSha: 'abc123',
      title: 'fix: broken thing',
      body,
      diagram,
    })

    expect(result).toEqual(ok(expect.objectContaining({ diagram: { _tag: 'Skipped', reason: 'No asset uploader is configured.' } })))
  })
})
