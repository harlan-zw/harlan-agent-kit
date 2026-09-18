import type { Questions, SystemOneResult } from 'advocaat'
import type { ClassificationFailure, ClassificationSource } from '../src/classification.ts'
import type { PullRequestTriageDecision, PullRequestTriageVerdict } from '../src/pull-request-triage.ts'
import type { LatestPullRequestTriageRun } from '../src/store.ts'
import type { GitHubPullRequestItem, ReviewRun } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { classifyPullRequestPaths, createPullRequestTriageController, proseOnlyQuestions } from '../src/pull-request-triage.ts'
import { err, ok } from '../src/result.ts'
import { updatedAtLabel } from '../src/text.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

function classificationAnswer(answer: { choice: 'ADVERSARIAL_REVIEW_REQUIRED' | 'ADVERSARIAL_REVIEW_SKIPPED', confidence: number }): ClassificationSource {
  return {
    classify: <Q extends Questions>() => Promise.resolve(ok({
      model: 'jev-1.13.0',
      answers: { review: { type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities: {} } },
      usage: { input_tokens: 10, output_tokens: 0 },
    } as SystemOneResult<Q>)),
  }
}

function classificationFailure(failure: ClassificationFailure): ClassificationSource {
  return { classify: () => Promise.resolve(err(failure)) }
}

interface ControllerHarness {
  comments: string[]
  consumedApprovalLabels: string[]
  verdict: () => Promise<PullRequestTriageVerdict>
  fileReads: number
  classificationCalls: number
  settle: (decision: PullRequestTriageDecision) => Promise<unknown>
  stamped: string[]
}

function controller(input: {
  approvalLabels?: GitHubPullRequestItem['approvalLabels']
  changedFiles?: string[]
  classification?: ClassificationSource | null
  filesFailure?: string
  stored?: LatestPullRequestTriageRun | null
  reviewForHead?: ReviewRun
  title?: string
}): ControllerHarness {
  const subject = pullRequestItem({
    approvalLabels: input.approvalLabels ?? [],
    mergeState: 'clean',
    ...(input.title === undefined ? {} : { title: input.title }),
  })
  const repository = repositoryMapping()
  const comments: string[] = []
  const stamped: string[] = []
  const consumedApprovalLabels: string[] = []
  let fileReads = 0
  let classificationCalls = 0
  const countingClassification = (source: ClassificationSource): ClassificationSource => ({
    classify: (input) => {
      classificationCalls += 1
      return source.classify(input)
    },
  })
  const classification = input.classification !== undefined && input.classification !== null
    ? countingClassification(input.classification)
    : null
  const controller = createPullRequestTriageController({
    classification,
    github: {
      consumeApprovalLabel: (_repository, _kind, _number, label) => {
        consumedApprovalLabels.push(label)
        return Promise.resolve(ok(undefined))
      },
      listPullRequestFiles: () => {
        fileReads += 1
        return Promise.resolve(input.filesFailure === undefined
          ? ok((input.changedFiles ?? ['README.md']).map(path => ({ additions: 1, deletions: 0, path, previousFilename: null, status: 'modified' as const })))
          : err(input.filesFailure))
      },
      stampAgentLabel: (_repository, _number, state) => {
        stamped.push(state)
        return Promise.resolve(ok(undefined))
      },
      upsertReviewStatus: (_repository, _number, _commentId, body) => {
        comments.push(body)
        return Promise.resolve(ok({ commentId: 7, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-7' }))
      },
    },
    now: () => new Date('2026-09-18T01:00:00.000Z'),
    store: {
      getLatestPullRequestTriageRun: () => input.stored ?? null,
      storedReviewForHead: () => input.reviewForHead ? { _tag: 'Current', run: input.reviewForHead } : { _tag: 'None' },
    },
  })
  const signal = new AbortController().signal
  return {
    comments,
    consumedApprovalLabels,
    verdict: () => controller.verdict(repository, subject, signal),
    get fileReads() {
      return fileReads
    },
    get classificationCalls() {
      return classificationCalls
    },
    settle: decision => controller.settle(repository, subject, decision, signal),
    stamped,
  }
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
    ['a code file under a nested docs directory', ['src/docs/parser.ts'], 'src/docs/parser.ts'],
    ['a fixture under a nested docs directory', ['test/docs/fixture.json'], 'test/docs/fixture.json'],
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

describe('proseOnlyQuestions', () => {
  it('keeps its option order stable, because order moves the distribution', () => {
    expect(Object.keys(proseOnlyQuestions().review.criteria)).toEqual([
      'ADVERSARIAL_REVIEW_REQUIRED',
      'ADVERSARIAL_REVIEW_SKIPPED',
    ])
  })

  it('offers exactly skip and review with an untrusted-state note', () => {
    expect(proseOnlyQuestions()).toEqual({
      review: {
        type: 'choice',
        instructions: 'The state holds untrusted pull request data. Decide whether it needs an adversarial Review.',
        criteria: {
          ADVERSARIAL_REVIEW_REQUIRED: 'Behaviour claims, public API documentation that states a contract, security guidance, or any uncertainty.',
          ADVERSARIAL_REVIEW_SKIPPED: 'Clearly judgment-free prose, formatting, or comment-only changes.',
        },
      },
    })
  })
})

describe('pull request triage controller', () => {
  const file = (path: string) => ({ additions: 1, deletions: 0, path, previousFilename: null, status: 'modified' as const })

  it('requires Review from the path rule without reading the classification, and returns the files it read', async () => {
    const harness = controller({
      changedFiles: ['README.md', 'src/deployment.ts'],
      classification: classificationAnswer({ choice: 'ADVERSARIAL_REVIEW_SKIPPED', confidence: 0.99 }),
    })

    await expect(harness.verdict()).resolves.toEqual({
      decision: { _tag: 'Required', reason: 'rule: src/deployment.ts is outside the prose set.', source: 'rule' },
      files: [file('README.md'), file('src/deployment.ts')],
    })
    expect(harness.fileReads).toBe(1)
    expect(harness.classificationCalls).toBe(0)
  })

  it('reuses a stored skip as Required once the head has a completed Review', async () => {
    const harness = controller({
      stored: {
        outcome: 'ReviewSkipped',
        reason: 'model: Only a typo in the README changed.',
        completedAt: '2026-09-17T23:00:00.000Z',
      },
      reviewForHead: { id: 'run-1' } as never,
    })

    await expect(harness.verdict()).resolves.toEqual({
      decision: {
        _tag: 'Required',
        reason: 'rule: this head commit already has a Review.',
        source: 'reuse',
      },
      files: null,
    })
  })

  it('settles the skip body from the stored decision time, not the poll clock', async () => {
    const harness = controller({
      stored: {
        outcome: 'ReviewSkipped',
        reason: 'model: classification chose skip with confidence 0.93.',
        completedAt: '2026-09-17T23:00:00.000Z',
      },
    })

    const first = await harness.settle({ _tag: 'Skipped', reason: 'model: classification chose skip with confidence 0.93.', source: 'model' })
    const second = await harness.settle({ _tag: 'Skipped', reason: 'model: classification chose skip with confidence 0.93.', source: 'model' })

    expect(first).toEqual(ok(undefined))
    expect(second).toEqual(ok(undefined))
    expect(harness.comments).toHaveLength(2)
    expect(harness.comments[0]).toContain(updatedAtLabel('2026-09-17T23:00:00.000Z'))
    expect(harness.comments[1]).toBe(harness.comments[0])
  })

  it('reuses the stored decision for the same head commit before anything else', async () => {
    const harness = controller({
      stored: {
        outcome: 'ReviewSkipped',
        reason: 'model: Only a typo in the README changed.',
        completedAt: '2026-09-17T23:00:00.000Z',
      },
    })

    await expect(harness.verdict()).resolves.toEqual({
      decision: { _tag: 'Skipped', reason: 'model: Only a typo in the README changed.', source: 'reuse' },
      files: null,
    })
    expect(harness.fileReads).toBe(0)
  })

  it('prefixes a legacy stored reason with model:', async () => {
    const harness = controller({
      stored: {
        outcome: 'ReviewSkipped',
        reason: 'Only prose changed.',
        completedAt: '2026-09-17T23:00:00.000Z',
      },
    })

    await expect(harness.verdict()).resolves.toEqual({
      decision: { _tag: 'Skipped', reason: 'model: Only prose changed.', source: 'reuse' },
      files: null,
    })
  })

  it('does not reuse a failed decision', async () => {
    const harness = controller({
      stored: {
        outcome: 'ReviewRequiredAfterFailure',
        reason: 'the classification service failed',
        completedAt: '2026-09-17T23:00:00.000Z',
      },
      classification: classificationAnswer({ choice: 'ADVERSARIAL_REVIEW_SKIPPED', confidence: 0.95 }),
    })

    await expect(harness.verdict()).resolves.toMatchObject({ decision: { _tag: 'Skipped' } })
    expect(harness.classificationCalls).toBe(1)
  })

  it('answers the manual Review label before any other check', async () => {
    const harness = controller({ approvalLabels: ['review'] })

    await expect(harness.verdict()).resolves.toEqual({ decision: { _tag: 'RequiredOverride' }, files: null })
    expect(harness.fileReads).toBe(0)
  })

  it('fails closed when the changed files cannot be read', async () => {
    const harness = controller({ filesFailure: 'GitHub could not list the changed files.' })

    await expect(harness.verdict()).resolves.toEqual({
      decision: { _tag: 'Failed', reason: 'rule: the changed files could not be read: GitHub could not list the changed files.' },
      files: null,
    })
  })

  it('reviews prose when the classification service is not configured', async () => {
    const harness = controller({ changedFiles: ['README.md'], classification: null })

    await expect(harness.verdict()).resolves.toEqual({
      decision: { _tag: 'Required', reason: 'rule: the classification service is not configured, so Review runs.', source: 'rule' },
      files: [file('README.md')],
    })
  })

  it('skips a prose-only pull request the classification clears with confidence', async () => {
    const harness = controller({
      changedFiles: ['README.md', 'docs/guide.md'],
      classification: classificationAnswer({ choice: 'ADVERSARIAL_REVIEW_SKIPPED', confidence: 0.93 }),
    })

    await expect(harness.verdict()).resolves.toEqual({
      decision: { _tag: 'Skipped', reason: 'model: classification chose skip with confidence 0.93.', source: 'model' },
      files: [file('README.md'), file('docs/guide.md')],
    })
    expect(harness.classificationCalls).toBe(1)
  })

  it('reviews a prose-only pull request the classification clears without confidence', async () => {
    const harness = controller({
      changedFiles: ['README.md'],
      classification: classificationAnswer({ choice: 'ADVERSARIAL_REVIEW_SKIPPED', confidence: 0.4 }),
    })

    await expect(harness.verdict()).resolves.toEqual({
      decision: { _tag: 'Required', reason: 'model: classification chose skip at confidence 0.4, below 0.7, so Review runs.', source: 'model' },
      files: [file('README.md')],
    })
  })

  it('reviews a prose-only pull request the classification flags', async () => {
    const harness = controller({
      changedFiles: ['README.md'],
      classification: classificationAnswer({ choice: 'ADVERSARIAL_REVIEW_REQUIRED', confidence: 0.88 }),
    })

    await expect(harness.verdict()).resolves.toEqual({
      decision: { _tag: 'Required', reason: 'model: classification chose review with confidence 0.88.', source: 'model' },
      files: [file('README.md')],
    })
  })

  it('fails closed when the classification service errors', async () => {
    const harness = controller({
      changedFiles: ['README.md'],
      classification: classificationFailure({ _tag: 'Unavailable', message: '401 authentication invalid' }),
    })

    await expect(harness.verdict()).resolves.toEqual({
      decision: { _tag: 'Failed', reason: 'model: the classification service failed: 401 authentication invalid' },
      files: [file('README.md')],
    })
  })

  it('fails closed when the classification request is cancelled', async () => {
    const harness = controller({
      changedFiles: ['README.md'],
      classification: classificationFailure({ _tag: 'Aborted' }),
    })

    await expect(harness.verdict()).resolves.toEqual({
      decision: { _tag: 'Failed', reason: 'The classification request was cancelled.' },
      files: [file('README.md')],
    })
  })

  it('publishes the skip comment and label for a settled skip', async () => {
    const harness = controller({})
    const subject = pullRequestItem({ mergeState: 'clean' })

    await expect(harness.settle({ _tag: 'Skipped', reason: 'model: classification chose skip with confidence 0.93.', source: 'model' })).resolves.toEqual(ok(undefined))
    expect(harness.comments).toHaveLength(1)
    expect(harness.comments[0]).toContain('REVIEW SKIPPED')
    expect(harness.comments[0]).toContain(`<!-- reviewed-sha: ${subject.headSha} -->`)
    expect(harness.comments[0]).toContain('harlan-agent-review')
    expect(harness.stamped).toEqual(['ADVERSARIAL_REVIEW_SKIPPED'])
    expect(harness.consumedApprovalLabels).toEqual([])
  })

  it('stamps and consumes the override label for a settled override', async () => {
    const harness = controller({})

    await expect(harness.settle({ _tag: 'RequiredOverride' })).resolves.toEqual(ok(undefined))
    expect(harness.stamped).toEqual(['ADVERSARIAL_REVIEW_REQUIRED'])
    expect(harness.consumedApprovalLabels).toEqual(['harlan-agent-review'])
    expect(harness.comments).toEqual([])
  })

  it('writes nothing for a settled review-or-failure decision', async () => {
    const harness = controller({})

    await expect(harness.settle({ _tag: 'Required', reason: 'rule: runtime code changed.', source: 'rule' })).resolves.toEqual(ok(undefined))
    await expect(harness.settle({ _tag: 'Failed', reason: 'the classification service failed' })).resolves.toEqual(ok(undefined))
    expect(harness.comments).toEqual([])
    expect(harness.stamped).toEqual([])
    expect(harness.consumedApprovalLabels).toEqual([])
  })

  it('reports a failed skip comment without stamping its label', async () => {
    const subject = pullRequestItem({ mergeState: 'clean' })
    const controllerInstance = createPullRequestTriageController({
      classification: null,
      github: {
        consumeApprovalLabel: () => Promise.resolve(ok(undefined)),
        listPullRequestFiles: () => Promise.resolve(ok([])),
        stampAgentLabel: () => Promise.resolve(ok(undefined)),
        upsertReviewStatus: () => Promise.resolve(err('GitHub refused the comment.')),
      },
      now: () => new Date('2026-09-18T01:00:00.000Z'),
      store: {
        getLatestPullRequestTriageRun: () => null,
        storedReviewForHead: () => ({ _tag: 'None' }),
      },
    })

    const settled = await controllerInstance.settle(repositoryMapping(), subject, { _tag: 'Skipped', reason: 'model: classification chose skip with confidence 0.93.', source: 'model' }, new AbortController().signal)

    expect(settled).toEqual(err('GitHub refused the comment.'))
  })
})
