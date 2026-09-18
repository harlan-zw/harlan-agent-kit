import type { ClassificationSource } from '../src/classification.ts'
import { jev } from 'advocaat'
import { describe, expect, it } from 'vitest'
import { createClassificationSource } from '../src/classification.ts'
import { CHECK_INFRASTRUCTURE_CONFIDENCE_FLOOR, checkFailureQuestions } from '../src/failure.ts'

/**
 * A live eval of the check failure residual classifier. Runs only with
 * credentials present:
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=$(cat ~/.config/harlan-github-agent/classification-token) \
 *     pnpm vitest run test/live-check-failure-eval.test.ts
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

const goldens: Array<{ name: string, logTail: string[], expected: 'Repairable' | 'Infrastructure' }> = [
  {
    name: 'build',
    logTail: ['> pnpm build', 'FATAL ERROR: Reached heap limit - Allocation failed - JavaScript heap out of memory', '##[error]Process completed with exit code 134'],
    expected: 'Repairable',
  },
  {
    name: 'test',
    logTail: ['  ✓ exports rows', '  ✗ exports an empty dashboard', '    expected file to exist', '##[error]Process completed with exit code 1'],
    expected: 'Repairable',
  },
  {
    name: 'build',
    logTail: ['node:internal/errors:490', 'Error: spawn ENOMEM', '    at ChildProcess.spawn (node:internal/child_process:521:17)', '##[error]Process completed with exit code 1'],
    expected: 'Infrastructure',
  },
  {
    name: 'install',
    logTail: ['npm ERR! network request to https://registry.npmjs.org failed, reason: read ECONNRESET', '##[error]Process completed with exit code 1'],
    expected: 'Infrastructure',
  },
  {
    name: 'build',
    logTail: ['../src/plugin.ts(112,5): error TS2345: Argument of type string is not assignable to parameter of type number.', '##[error]Process completed with exit code 2'],
    expected: 'Repairable',
  },
  {
    name: 'e2e',
    logTail: ['disk usage exceeded quota: 14.2 GB / 14.0 GB', '##[error]Process completed with exit code 1'],
    expected: 'Infrastructure',
  },
]

evalLive('live check failure residual', () => {
  it('calls every log the patterns cannot name correctly or keeps the repair', { timeout: 120_000 }, async () => {
    const classification = source as ClassificationSource
    const results: Array<{ name: string, expected: string, got: string, confidence: number }> = []
    for (const golden of goldens) {
      const result = await classification.classify({
        state: { check: golden.name, conclusion: 'failure', logTail: golden.logTail },
        questions: checkFailureQuestions(golden.name),
        signal: AbortSignal.timeout(30_000),
      })
      if (result._tag === 'Err')
        throw new Error(`The classification failed on "${golden.name}": ${result.error._tag === 'Aborted' ? 'cancelled' : result.error.message}`)
      const answer = result.value.answers.cause
      const confidence = Math.round(answer.confidence * 100) / 100
      results.push({ name: golden.name, expected: golden.expected, got: answer.choice, confidence })
    }
    for (const result of results)
      console.log(`${result.got === result.expected ? 'ok ' : 'MISS'} ${result.got.padEnd(15)}@${result.confidence} (want ${result.expected}) ${result.name} / ${result.expected === 'Infrastructure' ? 'infra log' : 'repo log'}`)
    // A wrong Infrastructure answer stops the repair and asks a person to fix
    // a host, so only confident infrastructure counts; every doubt repairs.
    const unsafe = results.filter(result => result.expected === 'Repairable' && result.got === 'Infrastructure' && result.confidence >= CHECK_INFRASTRUCTURE_CONFIDENCE_FLOOR)
    const correct = results.filter(result => result.got === result.expected || (result.expected === 'Infrastructure' && result.got === 'Repairable')).length
    expect(unsafe, `unsafe infrastructure calls: ${unsafe.map(result => result.name).join(', ')}`).toHaveLength(0)
    expect(correct).toBeGreaterThanOrEqual(Math.ceil(results.length * 0.75))
  })
})
