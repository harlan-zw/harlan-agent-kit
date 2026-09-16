import type { Result } from '../result.ts'
import type { RoutineDefinition } from './contract.ts'
import { err, ok } from '../result.ts'
import { candidateRoutine, candidateScanPrompt } from './candidates.ts'
import { MAXIMUM_REPORT_DETAIL_LENGTH } from './contract.ts'

/**
 * Paths that define the measurement itself.
 *
 * An agent asked to remove a Regression can always make the number go away by
 * weakening the Benchmark. Refusing the whole directory kills that option,
 * rather than asking a reviewer to notice it every time.
 */
const MEASUREMENT_PATHS = ['perf/', 'scripts/perf/']

export function refusesMeasurementChange(changedPaths: readonly string[]): Result<void, string> {
  const measurement = changedPaths.filter(path => MEASUREMENT_PATHS.some(prefix => path.startsWith(prefix)))
  if (measurement.length === 0)
    return ok(undefined)
  return err(`Issue work for a Regression must not change the measurement itself. Remove these paths: ${measurement.join(', ')}.`)
}

export const perfReview: RoutineDefinition = {
  ...candidateRoutine,
  schema: {
    ...candidateRoutine.schema,
    required: ['report', 'candidates'],
    properties: {
      ...candidateRoutine.schema.properties,
      report: { ...candidateRoutine.schema.properties.report, maxLength: MAXIMUM_REPORT_DETAIL_LENGTH },
    },
  },
  scanPrompt: input => candidateScanPrompt(input, `Read the installed harlan-agent-kit:perf-review Skill. Follow scan mode for this repository only.
Read the stored Measurements on the repository's notes ref and decide which Benchmarks carry a Regression.
Return a Markdown report within ${MAXIMUM_REPORT_DETAIL_LENGTH} characters, even when the series is too short to judge or no Measurement exists.
Name every Benchmark you judged, every Benchmark you refused to judge, and why.
Return one Candidate for each confirmed Regression, and none for a Suspect.
Keep repository files and GitHub read only.
Do not duplicate work already owned by an open issue or pull request.`),
  parseResponse: (input) => {
    const parsed = candidateRoutine.parseResponse(input)
    if (parsed._tag === 'Err')
      return parsed
    if (parsed.value.report.length > MAXIMUM_REPORT_DETAIL_LENGTH)
      return err(`The performance review report exceeds ${MAXIMUM_REPORT_DETAIL_LENGTH} characters. Shorten it and say which Benchmarks it omits.`)
    return parsed.value.report === '' ? err('The performance review Routine answered without its report.') : parsed
  },
  issueWork: {
    ...candidateRoutine.issueWork,
    prompt: () => 'Read the installed harlan-agent-kit:perf-review Skill. Follow implementation mode within this prepared worktree. Reproduce the paired delta locally with the harness, find what causes it, and fix that. Prove the repair with the same harness command. Never change the Benchmark, its case files, or the harness. Do not commit, push, publish, or change GitHub settings. The controller owns publication.',
    verifyChanges: (_target, changedPaths) => refusesMeasurementChange(changedPaths),
  },
}
