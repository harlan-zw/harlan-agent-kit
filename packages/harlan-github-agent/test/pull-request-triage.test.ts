import type { LatestPullRequestTriageRun } from '../src/store.ts'
import type { ClaimedAdversarialReviewTask } from '../src/types.ts'
import type { ProviderCapture } from './fixtures.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { classifyPullRequestPaths, createPullRequestTriageAgent } from '../src/pull-request-triage.ts'
import { agentRuntime, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

function reviewTask(title: string): ClaimedAdversarialReviewTask {
  return {
    id: 'review-task',
    kind: 'adversarial_review',
    repository: 'harlan-zw/example',
    pullRequestNumber: 24,
    revisionId: 'revision-1',
    state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-28T02:00:00.000Z' },
    updatedAt: '2026-08-28T01:00:00.000Z',
    repositoryMapping: repositoryMapping(),
    pullRequest: pullRequestItem({ mergeState: 'clean', title }),
    rerun: { _tag: 'NotRequested' },
  }
}

function triageAgent(options: {
  capture: ProviderCapture
  modelReply?: unknown
  stored?: LatestPullRequestTriageRun | null
}) {
  return createPullRequestTriageAgent({
    now: () => new Date('2026-08-28T01:00:00.000Z'),
    runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(options.modelReply ?? {
      _tag: 'ADVERSARIAL_REVIEW_SKIPPED',
      reason: 'Only a typo in the README changed.',
    }), options.capture)),
    store: {
      getLatestPullRequestTriageRun: () => options.stored ?? null,
      getWorkerSession: () => null,
      saveWorkerSession: () => undefined,
    },
    workspace: '/tmp/harlan-github-agent',
  })
}

describe('classifyPullRequestPaths', () => {
  it.each([
    ['a TypeScript source file', ['README.md', 'src/deployment.ts'], 'src/deployment.ts'],
    ['a Vue component', ['docs/guide.md', 'app/components/Hero.vue'], 'app/components/Hero.vue'],
    ['dependencies', ['package.json', 'pnpm-lock.yaml'], 'package.json'],
    ['a skill next to docs', ['README.md', 'skills/pr/SKILL.md'], 'skills/pr/SKILL.md'],
    ['agent instructions', ['docs/index.md', 'AGENTS.md'], 'AGENTS.md'],
    ['a workflow under docs-only prose', ['docs/setup.md', '.github/workflows/ci.yml'], '.github/workflows/ci.yml'],
    ['a Claude command', ['CHANGELOG.md', '.claude/commands/ship.md'], '.claude/commands/ship.md'],
    ['a Codex prompt', ['LICENSE', '.codex/prompts/review.md'], '.codex/prompts/review.md'],
    ['a Markdown file under .github', ['.github/PULL_REQUEST_TEMPLATE.md'], '.github/PULL_REQUEST_TEMPLATE.md'],
    ['no changed files', [], undefined],
  ])('requires Review for %s', (_label, changedFiles, path) => {
    const verdict = classifyPullRequestPaths(changedFiles)
    if (path === undefined) {
      expect(verdict).toEqual({ _tag: 'ProseOnly' })
      return
    }
    expect(verdict).toEqual({ _tag: 'ReviewRequired', path })
  })

  it('leaves a prose-only pull request to the model', () => {
    expect(classifyPullRequestPaths([
      'README.md',
      'docs/guide/getting-started.mdx',
      'packages/engine/CHANGELOG.md',
      'LICENSE',
      'LICENSE.md',
      'notes/todo.txt',
      'docs/assets/diagram.svg',
    ])).toEqual({ _tag: 'ProseOnly' })
  })
})

describe('pull request triage Agent', () => {
  it('requires Review from the path rule without an Agent turn', async () => {
    const capture: ProviderCapture = { requests: [] }
    const agent = triageAgent({ capture })

    const result = await agent.run(reviewTask('chore: update workspace dependencies'), {
      changedFiles: [
        'package.json',
        'packages/engine/test/icebird-bigint-stringify.test.ts',
        'pnpm-lock.yaml',
      ],
    }, new AbortController().signal)

    expect(result).toEqual({
      _tag: 'Ok',
      value: {
        _tag: 'ADVERSARIAL_REVIEW_REQUIRED',
        reason: 'rule: package.json is outside the prose set.',
        source: 'rule',
      },
    })
    expect(capture.requests).toHaveLength(0)
  })

  it('reuses the stored decision for the same head commit before an Agent turn', async () => {
    const capture: ProviderCapture = { requests: [] }
    const agent = triageAgent({
      capture,
      stored: {
        outcome: 'ReviewSkipped',
        reason: 'model: Only a typo in the README changed.',
        completedAt: '2026-08-27T23:00:00.000Z',
      },
    })

    const result = await agent.run(reviewTask('docs: fix a typo'), {
      changedFiles: ['README.md'],
    }, new AbortController().signal)

    expect(result).toEqual({
      _tag: 'Ok',
      value: {
        _tag: 'ADVERSARIAL_REVIEW_SKIPPED',
        reason: 'model: Only a typo in the README changed.',
        source: 'reuse',
      },
    })
    expect(capture.requests).toHaveLength(0)
  })

  it('does not reuse a failed decision', async () => {
    const capture: ProviderCapture = { requests: [] }
    const agent = triageAgent({
      capture,
      stored: {
        outcome: 'ReviewRequiredAfterFailure',
        reason: 'spawn opencode ENOENT',
        completedAt: '2026-08-27T23:00:00.000Z',
      },
    })

    const result = await agent.run(reviewTask('docs: fix a typo'), {
      changedFiles: ['README.md'],
    }, new AbortController().signal)

    expect(result._tag).toBe('Ok')
    expect(capture.requests).toHaveLength(1)
  })

  it('sends a prose-only pull request to the cheap model with title and paths only', async () => {
    const capture: ProviderCapture = { requests: [] }
    const agent = triageAgent({ capture })

    const result = await agent.run(reviewTask('docs: fix a typo'), {
      changedFiles: ['README.md', 'docs/guide.md'],
    }, new AbortController().signal)

    expect(result).toEqual({
      _tag: 'Ok',
      value: {
        _tag: 'ADVERSARIAL_REVIEW_SKIPPED',
        reason: 'model: Only a typo in the README changed.',
        source: 'model',
      },
    })
    expect(capture.requests).toEqual([expect.objectContaining({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      sessionId: null,
    })])
    const prompt = capture.requests[0]?.prompt ?? ''
    expect(prompt).toContain('Do not use tools or inspect the repository')
    expect(prompt).toContain('Any uncertainty requires ADVERSARIAL_REVIEW_REQUIRED')
    expect(prompt).toContain('"title":"docs: fix a typo"')
    expect(prompt).toContain('"changedFiles":["README.md","docs/guide.md"]')
    expect(prompt).not.toContain('"body"')
  })

  it('rejects a malformed model answer instead of waiving Review', async () => {
    const capture: ProviderCapture = { requests: [] }
    const agent = triageAgent({ capture, modelReply: { _tag: 'MAYBE', reason: '' } })

    const result = await agent.run(reviewTask('docs: fix a typo'), {
      changedFiles: ['README.md'],
    }, new AbortController().signal)

    expect(result).toEqual({ _tag: 'Err', error: 'The Agent returned an invalid pull request triage result.' })
  })
})
