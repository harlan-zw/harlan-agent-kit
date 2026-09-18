import type { ClassificationSource } from '../src/classification.ts'
import { jev } from 'advocaat'
import { describe, expect, it } from 'vitest'
import { createClassificationSource } from '../src/classification.ts'
import { ISSUE_ROUTE_CONFIDENCE_FLOOR, issueRouteQuestions } from '../src/issue-classification.ts'

/**
 * A live eval of the Issue triage route questions, using the real model
 * behind the real gateway. Runs only with credentials present:
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=$(cat ~/.config/harlan-github-agent/classification-token) \
 *     pnpm vitest run test/live-issue-route-eval.test.ts
 *
 * Hand-labelled starter goldens; evaluate-issue-triage replaces them with the
 * recorded journal decisions once the service runs with a band set.
 */
const source: ClassificationSource | null = process.env.CLOUDFLARE_ACCOUNT_ID === undefined || process.env.CLOUDFLARE_API_TOKEN === undefined
  ? null
  : createClassificationSource({
      client: jev({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        apiToken: process.env.CLOUDFLARE_API_TOKEN,
        ...(process.env.CLOUDFLARE_AI_GATEWAY_ID === undefined ? {} : { gatewayId: process.env.CLOUDFLARE_AI_GATEWAY_ID }),
      }),
    })

const evalLive = describe.skipIf(source === null)

const goldens: Array<{ title: string, body: string, comments: string[], expected: 'NEEDS_INFO' | 'WAIT_TO_IMPLEMENT' | 'AGENT_TRIAGE' }> = [
  { title: 'It crashes', body: 'It broke when I used it. Please fix.', comments: [], expected: 'NEEDS_INFO' },
  { title: 'TypeError on login with empty password', body: 'Steps: start the dev server, open /login, submit an empty password. Console shows TypeError: cannot read properties of undefined. Node 24, Chrome 130.', comments: [], expected: 'AGENT_TRIAGE' },
  { title: 'Dark mode please', body: 'The dashboard has no dark mode. It should follow the system preference.', comments: [], expected: 'AGENT_TRIAGE' },
  { title: 'Waiting on the v3 migration', body: 'This depends on the storage layer rewrite landing first. Track it here so we do not lose it.', comments: [], expected: 'WAIT_TO_IMPLEMENT' },
  { title: 'Bug in export', body: 'Export is wrong sometimes.', comments: [], expected: 'NEEDS_INFO' },
  { title: 'Dependency update breaks the build', body: 'After updating framework 2 to 3, the build fails on the plugin step. Reproduced on a clean install with the lockfile in the reproduction repository.', comments: [], expected: 'AGENT_TRIAGE' },
  { title: 'It crashes', body: 'It broke when I used it.', comments: ['Which page were you on?', 'The settings page, after saving.', 'Thanks, reproduced: saving with an empty name throws.'], expected: 'AGENT_TRIAGE' },
  // A support question names work the Agent can take (answer it, file the
  // docs gap), so it is not missing information.
  { title: 'Support question about limits', body: 'How many sites can I add? Also the docs do not say.', comments: [], expected: 'AGENT_TRIAGE' },
  { title: 'Docs typo in install guide', body: 'The install guide says pnpm add where it means pnpm install. One line fix.', comments: [], expected: 'AGENT_TRIAGE' },
  { title: 'Blocked on the API redesign', body: 'Do not implement until the endpoint shape is decided in the RFC.', comments: [], expected: 'WAIT_TO_IMPLEMENT' },
  { title: 'Performance regression after 2.1', body: 'The list view renders 3000 rows in 4s now, was 400ms on 2.0. Profile attached in the linked discussion.', comments: [], expected: 'AGENT_TRIAGE' },
  { title: 'Cannot install', body: 'It does not work.', comments: [], expected: 'NEEDS_INFO' },
]

evalLive('live issue triage route', () => {
  it('answers every golden correctly or keeps the Agent', { timeout: 180_000 }, async () => {
    const classification = source as ClassificationSource
    const results: Array<{ title: string, expected: string, got: string, confidence: number }> = []
    for (const golden of goldens) {
      const result = await classification.classify({
        state: { title: golden.title, body: golden.body, comments: golden.comments },
        questions: issueRouteQuestions(),
        signal: AbortSignal.timeout(30_000),
      })
      if (result._tag === 'Err')
        throw new Error(`The classification failed on "${golden.title}": ${result.error._tag === 'Aborted' ? 'cancelled' : result.error.message}`)
      results.push({
        title: golden.title,
        expected: golden.expected,
        got: result.value.answers.route.choice,
        confidence: Math.round(result.value.answers.route.confidence * 100) / 100,
      })
    }
    for (const result of results)
      console.log(`${result.got === result.expected ? 'ok ' : 'MISS'} ${result.got.padEnd(17)}@${result.confidence} (want ${result.expected}) ${result.title}`)
    // An unsafe bypass routes NEEDS_INFO or WAIT at the shipped band for work
    // the Agent should take; the safe miss only spends an Agent turn.
    const unsafe = results.filter(result => result.expected === 'AGENT_TRIAGE'
      && (result.got === 'NEEDS_INFO' || result.got === 'WAIT_TO_IMPLEMENT')
      && result.confidence >= ISSUE_ROUTE_CONFIDENCE_FLOOR)
    const correct = results.filter(result => result.got === result.expected).length
    expect(unsafe, `unsafe bypasses: ${unsafe.map(result => result.title).join(', ')}`).toHaveLength(0)
    expect(correct).toBeGreaterThanOrEqual(Math.ceil(results.length * 0.7))
  })
})
