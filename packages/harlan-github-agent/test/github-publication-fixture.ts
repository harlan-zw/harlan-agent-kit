import type { Octokit } from 'octokit'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { ok } from '../src/result.ts'

/** A real source with recorded GitHub requests and changes during its awaited boundaries. */
export function githubPublicationFixture(options: {
  body: string
  mode: 'create' | 'update' | 'legacy' | 'idempotent'
  boundary?: 'comments' | 'legacy token' | 'label token' | 'labels' | 'create label' | 'add label' | 'remove label'
  change?: () => void
  labels?: string[]
}) {
  const writes: string[] = []
  let changed = false
  const boundary = (name: typeof options.boundary) => {
    if (!changed && name === options.boundary) {
      changed = true
      options.change?.()
    }
  }
  const actor = options.mode === 'legacy' ? 'harlan-zw' : 'harlan-github-agent[bot]'
  const comment = {
    id: 42,
    user: { login: actor },
    author_association: 'OWNER',
    body: options.mode === 'idempotent' ? options.body : options.body.replace(/### 🤖 .*/, '### 🤖 REVIEWING'),
    html_url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
    issue_url: 'https://api.github.com/repos/harlan-zw/example/issues/24',
  }
  let comments = options.mode === 'create' ? [] : [comment]
  let labels = options.labels ?? ['harlan-agent-blocked', 'harlan-agent-pending']
  let tokenReads = 0
  const writeComment = (name: string, input: { body: string }) => {
    writes.push(name)
    comment.body = input.body
    comments = [comment]
    return Promise.resolve({ data: comment })
  }
  const octokit = {
    paginate: () => {
      boundary('comments')
      return Promise.resolve(comments)
    },
    rest: { issues: {
      listComments: () => undefined,
      getComment: () => Promise.resolve({ data: comment }),
      createComment: (input: { body: string }) => writeComment('create comment', input),
      updateComment: (input: { body: string }) => writeComment('update comment', input),
      get: () => {
        boundary('labels')
        return Promise.resolve({ data: { labels } })
      },
      createLabel: () => {
        writes.push('create label')
        boundary('create label')
        return Promise.resolve({ data: {} })
      },
      addLabels: (input: { labels: string[] }) => {
        writes.push('add label')
        labels = [...new Set([...labels, ...input.labels])]
        boundary('add label')
        return Promise.resolve({ data: labels })
      },
      removeLabel: (input: { name: string }) => {
        writes.push('remove label')
        labels = labels.filter(label => label !== input.name)
        boundary('remove label')
        return Promise.resolve({ data: labels })
      },
    } },
  } as unknown as Octokit
  const source = createGitHubAgentSource({
    actorLogin: () => 'harlan-github-agent[bot]',
    createClient: () => octokit,
    tokens: {
      getToken: () => {
        tokenReads += 1
        if (tokenReads > 1)
          boundary('label token')
        return Promise.resolve(ok({ token: 'app', expiresAt: '2099-01-01T00:00:00.000Z' }))
      },
      invalidate: () => undefined,
    },
    legacyActor: { login: 'harlan-zw', tokens: {
      getToken: () => {
        boundary('legacy token')
        return Promise.resolve(ok({ token: 'user', expiresAt: '2099-01-01T00:00:00.000Z' }))
      },
      invalidate: () => undefined,
    } },
  })
  return { writes, source: { upsertReviewStatus: source.upsertReviewStatus, stampAgentLabel: source.stampAgentLabel } }
}
