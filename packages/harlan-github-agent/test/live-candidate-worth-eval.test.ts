import type { ClassificationSource } from '../src/classification.ts'
import { jev } from 'advocaat'
import { describe, expect, it } from 'vitest'
import { createClassificationSource } from '../src/classification.ts'
import { worthFiling } from '../src/routines/candidates.ts'

/**
 * A live eval of the Candidate worth gate, using the real model behind the
 * real gateway. Runs only with credentials present:
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=$(cat ~/.config/harlan-github-agent/classification-token) \
 *     pnpm vitest run test/live-candidate-worth-eval.test.ts
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

const routine = 'harlan-zw/example:ci-review'

const goldens: Array<{ title: string, target: string, claim: string, verification: string, files: number, expected: boolean }> = [
  { title: 'Flaky test retries hide a real race in the scheduler', target: 'src/scheduler.ts', claim: 'The test retries a race instead of fixing it, so failures surface elsewhere.', verification: 'pnpm test scheduler', files: 2, expected: true },
  { title: 'Dependency updates pending', target: 'package.json', claim: 'Three dependencies are behind their latest releases.', verification: 'pnpm outdated', files: 2, expected: true },
  { title: 'The same Sentry event count grew by one', target: 'scripts/alerts.log', claim: 'The occurrence count in the alert title is higher than yesterday.', verification: 'cat scripts/alerts.log', files: 1, expected: false },
  { title: 'Rename the memory routine to the new spelling', target: '.github/routines.yml', claim: 'The routine name drifted from the glossary spelling.', verification: 'grep routines.yml', files: 1, expected: false },
  { title: 'Export fails silently on empty dashboards', target: 'src/export.ts', claim: 'An empty dashboard exports a file with no error and no rows.', verification: 'pnpm test export-empty', files: 3, expected: true },
  { title: 'Week-old count of open dependency alerts', target: 'pnpm-lock.yaml', claim: 'The audit alert count is from last week and unchanged.', verification: 'pnpm audit', files: 1, expected: false },
  { title: 'Dead link in the contributing guide', target: 'CONTRIBUTING.md', claim: 'The issue template link 404s.', verification: 'curl -I <url>', files: 1, expected: true },
  { title: 'A candidate with no verifiable defect', target: 'src/index.ts', claim: 'The code feels fragile around startup.', verification: 'none', files: 4, expected: false },
]

evalLive('live candidate worth gate', () => {
  it('keeps every worth-filing candidate and drops only confident noise', { timeout: 120_000 }, async () => {
    const classification = source as ClassificationSource
    const results: Array<{ title: string, expected: boolean, kept: boolean }> = []
    for (const golden of goldens) {
      const kept = await worthFiling({ classification, routineName: routine, candidate: { ...golden, estimatedChangedFiles: golden.files } })
      results.push({ title: golden.title, expected: golden.expected, kept })
    }
    for (const result of results)
      console.log(`${result.kept === result.expected ? 'ok ' : 'MISS'} ${result.kept ? 'kept ' : 'dropped'} (want ${result.expected ? 'kept  ' : 'dropped'}) ${result.title}`)
    // A lost Candidate is invisible, so a wrongly dropped worth-filing
    // candidate is the failure that matters; a wrongly kept one costs a close.
    const unsafe = results.filter(result => result.expected && !result.kept)
    const correct = results.filter(result => result.kept === result.expected).length
    expect(unsafe, `dropped worth-filing candidates: ${unsafe.map(result => result.title).join(', ')}`).toHaveLength(0)
    expect(correct).toBeGreaterThanOrEqual(Math.ceil(results.length * 0.7))
  })
})
