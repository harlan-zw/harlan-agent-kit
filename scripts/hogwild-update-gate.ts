// Decides whether `pnpm service:hogwild:update` may file an Update.
//
// Each Update drains new Tasks for minutes and drops control connections. The
// nightly scheduled Update ships merged controller code, but it moves only the
// Hogwild checkout. So the helper runs only when the range from the deployed
// commit to the target reaches the desktop client, a systemd unit, or the
// synced env, or when the caller says why the change cannot wait. On
// 2026-11-24 eight helper Updates changed none of these files.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const PAIRED_FILE_PATTERNS: readonly RegExp[] = [
  /^packages\/harlan-github-agent\/src\/desktop-[^/]+\.ts$/,
  /^scripts\/desktop-agent\.service$/,
  /^scripts\/hogwild-service\.conf$/,
  /^scripts\/repository-env-files$/,
  /^scripts\/repository-env\.sh$/,
]

export type HogwildUpdateBasis
  = | { _tag: 'ChangedPaths', paths: readonly string[] }
    | { _tag: 'Override', reason: string }

export type HogwildUpdateDecision
  = | { _tag: 'Ok', note: string }
    | { _tag: 'Refused', message: string }

export function decideHogwildUpdate(basis: HogwildUpdateBasis): HogwildUpdateDecision {
  if (basis._tag === 'Override') {
    const reason = basis.reason.replace(/\s+/g, ' ').trim()
    return reason.length === 0
      ? { _tag: 'Refused', message: 'The --reason value is empty. Say why this Update cannot wait for the nightly Update.' }
      : { _tag: 'Ok', note: `Update override: ${reason}` }
  }
  const paired = basis.paths.filter(path => PAIRED_FILE_PATTERNS.some(pattern => pattern.test(path)))
  return paired.length === 0
    ? { _tag: 'Refused', message: 'No paired file changed, so the nightly Update ships this commit. If it must ship now, add --reason \'WHY\'.' }
    : { _tag: 'Ok', note: `Paired files changed: ${paired.join(', ')}` }
}

// Usage: `hogwild-update-gate.ts < paths` with one changed path per line, or
// `hogwild-update-gate.ts --reason WHY`.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, reason] = process.argv.slice(2)
  const basis: HogwildUpdateBasis = flag === '--reason'
    ? { _tag: 'Override', reason: reason ?? '' }
    : { _tag: 'ChangedPaths', paths: readFileSync(0, 'utf8').split('\n').filter(Boolean) }
  const decision = decideHogwildUpdate(basis)
  if (decision._tag === 'Refused') {
    process.stderr.write(`${decision.message}\n`)
    process.exitCode = 1
  }
  else {
    process.stdout.write(`${decision.note}\n`)
  }
}
