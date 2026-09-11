#!/usr/bin/env bun
// Effectful shell for the `hw` CLI. Runs the plan from `plan.ts` step by step
// and stops at the first failure. Run it with bun; it needs no dependencies.

import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { plan, stepArgv } from './plan.ts'

const result = plan(process.argv.slice(2))
if (result._tag === 'Err') {
  console.error(result.message)
  process.exit(2)
}

for (const step of result.steps) {
  if (step.title)
    console.log(`\x1B[1m# ${step.title} (${step.host})\x1B[0m`)
  const [file, ...args] = stepArgv(step)
  const { status } = spawnSync(file as string, args, { stdio: 'inherit' })
  if (status !== 0) {
    console.error(`Step failed with exit ${status} on ${step.host}: ${step.command}`)
    process.exit(status ?? 1)
  }
}
