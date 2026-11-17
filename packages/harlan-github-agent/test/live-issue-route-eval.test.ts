import type { ClassificationSource } from '../src/classification.ts'
import type { IssueRoute } from '../src/issue-classification.ts'
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

const goldens: Array<{ title: string, body: string, comments: string[], expected: IssueRoute }> = [
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
  // Clear discussions: nothing is broken and nothing concrete is asked for yet.
  { title: 'Thoughts on supporting Bun?', body: 'Not a bug, just curious whether you have considered running on Bun. Would love to hear your thinking.', comments: [], expected: 'DISCUSSION' },
  { title: 'Idea: a plugin system', body: 'What if the module exposed hooks so other modules could extend it? Happy to talk through the shape before anyone writes code.', comments: [], expected: 'DISCUSSION' },
  { title: 'How do you structure large projects with this?', body: 'Everything works fine. I am asking how others organise configuration across twenty sites. Any patterns you recommend?', comments: [], expected: 'DISCUSSION' },
  { title: 'RFC: should v6 drop CommonJS?', body: 'Opening this to gather opinions before deciding anything. Who still depends on the CJS build?', comments: [], expected: 'DISCUSSION' },
  { title: 'Thank you!', body: 'This module saved me hours. No issue, just wanted to say thanks.', comments: [], expected: 'DISCUSSION' },
  { title: 'Roadmap question', body: 'Is there a plan for the next major? Just wondering what direction the project is heading.', comments: [], expected: 'DISCUSSION' },
  // Near misses: a real defect or a concrete change, phrased as a question,
  // a proposal, or a conversation. Routing one DISCUSSION at the band kills
  // the trial.
  { title: 'Is this expected? Sitemap omits pages with trailing slash', body: 'Quick question: with trailingSlash: true, /blog/ is missing from sitemap.xml on 7.2.1. Without the option it appears. Repro: init a project, add the module, set trailingSlash, run generate. Is this a bug?', comments: [], expected: 'AGENT_TRIAGE' },
  { title: 'Question about the new cache option', body: 'Wondering if anyone else sees this: since 3.0 the cache option is ignored and every request hits the API. Logs attached show no cache reads. Node 22.', comments: [], expected: 'AGENT_TRIAGE' },
  { title: 'Proposal: fix the doubled canonical URL on paginated routes', body: 'Paginated routes emit the canonical https://site.com/page/2/page/2. The doubled segment comes from joinURL in the canonical helper. Proposing we strip the page suffix before joining.', comments: [], expected: 'AGENT_TRIAGE' },
  { title: 'Discussion: memory leak in dev server?', body: 'Opening for discussion. After an hour of dev with HMR, memory climbs from 300MB to 4GB and the process crashes with heap out of memory. Reproduces with the starter template on Node 24.', comments: [], expected: 'AGENT_TRIAGE' },
  { title: 'Should the docs mention the env variable?', body: 'NUXT_SITE_URL is read at runtime but the configuration page never mentions it. Adding one line there would have saved me an hour.', comments: [], expected: 'AGENT_TRIAGE' },
]

evalLive('live issue triage route', () => {
  it('answers every golden correctly or keeps the Agent', { timeout: 300_000 }, async () => {
    const classification = source as ClassificationSource
    const results: Array<{ title: string, expected: string, got: string, confidence: number, needsCodebaseReview: number }> = []
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
        needsCodebaseReview: Math.round(result.value.answers.needsCodebaseReview.noul * 100) / 100,
      })
    }
    for (const result of results)
      console.log(`${result.got === result.expected ? 'ok ' : 'MISS'} ${result.got.padEnd(17)}@${result.confidence} code ${result.needsCodebaseReview} (want ${result.expected}) ${result.title}`)
    // An unsafe bypass routes NEEDS_INFO or WAIT at the shipped band for work
    // the Agent should take; the safe miss only spends an Agent turn.
    const unsafe = results.filter(result => result.expected === 'AGENT_TRIAGE'
      && (result.got === 'NEEDS_INFO' || result.got === 'WAIT_TO_IMPLEMENT')
      && result.confidence >= ISSUE_ROUTE_CONFIDENCE_FLOOR)
    // An unsafe Discussion skip is the trial's kill signal: live mode would
    // skip Agent triage on something that is not a discussion.
    const unsafeDiscussion = results.filter(result => result.expected !== 'DISCUSSION'
      && result.got === 'DISCUSSION'
      && result.confidence >= ISSUE_ROUTE_CONFIDENCE_FLOOR
      && result.needsCodebaseReview < 0.5)
    const correct = results.filter(result => result.got === result.expected).length
    expect(unsafe, `unsafe bypasses: ${unsafe.map(result => result.title).join(', ')}`).toHaveLength(0)
    expect(unsafeDiscussion, `unsafe Discussion skips: ${unsafeDiscussion.map(result => result.title).join(', ')}`).toHaveLength(0)
    expect(correct).toBeGreaterThanOrEqual(Math.ceil(results.length * 0.7))
  })
})
