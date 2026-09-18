import type { ClassificationSource } from '../src/classification.ts'
import type { GitHubPullRequestItem } from '../src/types.ts'
import { jev } from 'advocaat'
import { describe, expect, it } from 'vitest'
import { createClassificationSource } from '../src/classification.ts'
import { classificationDecision } from '../src/pull-request-triage.ts'

/**
 * A live eval of the Pull request triage route, using the real model behind
 * the real gateway. Runs only with credentials present:
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=$(cat ~/.config/harlan-github-agent/classification-token) \
 *     pnpm vitest run test/live-pr-triage-eval.test.ts
 *
 * The examples are hand-labelled starter goldens. Once the journal carries
 * decisions with their file lists, evaluate-triage replaces this set with the
 * recorded one, and the band comes from that data.
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

const goldens: Array<{ title: string, changedFiles: string[], expected: 'Skipped' | 'Required' }> = [
  { title: 'docs: fix typo in getting started', changedFiles: ['docs/getting-started.md'], expected: 'Skipped' },
  { title: 'docs: update README install steps for the v3 CLI flags', changedFiles: ['README.md'], expected: 'Required' },
  { title: 'docs: fix broken anchor links in the guide', changedFiles: ['docs/guide.md'], expected: 'Skipped' },
  { title: 'docs: document the new authentication options', changedFiles: ['docs/auth.md'], expected: 'Required' },
  { title: 'chore: update changelog for 2.1.0', changedFiles: ['CHANGELOG.md'], expected: 'Skipped' },
  { title: 'docs: add security policy', changedFiles: ['SECURITY.md'], expected: 'Required' },
  { title: 'docs: fix spelling of "recieve" in the faq', changedFiles: ['docs/faq.md'], expected: 'Skipped' },
  { title: 'docs: rewrite the API reference for the breaking changes', changedFiles: ['docs/api.md'], expected: 'Required' },
  { title: 'typo', changedFiles: ['README.md'], expected: 'Skipped' },
  { title: 'docs: clarify when a token expires', changedFiles: ['docs/tokens.md'], expected: 'Required' },
  { title: 'docs: update licence year', changedFiles: ['LICENSE'], expected: 'Skipped' },
  { title: 'docs: add a workaround for CVE-2023-1234', changedFiles: ['docs/security.md'], expected: 'Required' },
]

evalLive('live pull request triage route', () => {
  it('answers every golden correctly or fails safe', { timeout: 120_000 }, async () => {
    const classification = source as ClassificationSource
    const results: Array<{ title: string, expected: string, got: string, reason: string }> = []
    for (const golden of goldens) {
      const decision = await classificationDecision({
        classification,
        subject: { title: golden.title } as GitHubPullRequestItem,
        changedFiles: golden.changedFiles,
        signal: AbortSignal.timeout(30_000),
      })
      const got = decision._tag === 'Skipped' ? 'Skipped' : 'Required'
      results.push({ title: golden.title, expected: golden.expected, got, reason: 'reason' in decision ? decision.reason : '' })
    }
    for (const result of results)
      console.log(`${result.got === result.expected ? 'ok ' : 'MISS'} ${result.got.padEnd(8)} (want ${result.expected}) ${result.title}`)
    const unsafe = results.filter(result => result.expected === 'Required' && result.got === 'Skipped')
    const correct = results.filter(result => result.got === result.expected).length
    expect(unsafe, `unsafe skips: ${unsafe.map(result => result.title).join(', ')}`).toHaveLength(0)
    expect(correct).toBeGreaterThanOrEqual(Math.ceil(results.length * 0.75))
  })
})
