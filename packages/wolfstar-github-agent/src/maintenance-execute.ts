#!/usr/bin/env node
import type { MaintenanceExecution } from './maintenance-scope.ts'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CACHED_CONTEXT_BUDGET } from './agent-provider.ts'
import { runAgentSandboxCommand } from './agent-sandbox.ts'
import { createCodexProvider } from './codex-provider.ts'
import { createOpencodeProvider } from './opencode-provider.ts'
import { createReviewProofDuplex } from './review-proof-duplex.ts'

async function main(): Promise<void> {
  if (!process.env.WOLFSTAR_HOST_RESERVATION) throw new Error('The maintenance worker requires shared host admission.')
  const path = process.argv[2]
  if (path === undefined) throw new Error('The maintenance request file is required.')
  // This owner-only file comes from the trusted controller, never repository code.
  const input = JSON.parse(await readFile(path, 'utf8')) as MaintenanceExecution
  const controller = new AbortController()
  process.once('SIGTERM', () => controller.abort())
  process.once('SIGINT', () => controller.abort())
  const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
  if (input._tag === 'Check') {
    const result = await runAgentSandboxCommand({
      ...input.input,
      signal: controller.signal,
      environment: { ...process.env, CI: 'true' },
    })
    emit({ _tag: 'CheckResult', exitCode: result.exitCode, stdout: result.stdout ?? '', stderr: result.stderr ?? '' })
    return
  }
  if (input._tag !== 'Turn' || (input.name !== 'codex' && input.name !== 'opencode'))
    throw new Error('The maintenance request is invalid.')
  const proof = createReviewProofDuplex(process.stdin, process.stdout)
  // No nested systemd slices: every sandbox inherits the already charged scope.
  const proofOptions = { reviewProofAuthority: () => proof.authority }
  const provider =
    input.name === 'codex'
      ? createCodexProvider(proofOptions)
      : createOpencodeProvider({
          ...proofOptions,
          cachedContextBudget: DEFAULT_CACHED_CONTEXT_BUDGET,
          environment: process.env,
        })
  try {
    for await (const event of provider.runTurn({ ...input.request, signal: controller.signal })) emit(event)
  } finally {
    proof.close()
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
