import type { RoutineCandidate, RoutineDefinition, RoutineScanInput } from './contract.ts'
import { createHash } from 'node:crypto'
import { TOOLCHAIN_LINES } from '../agent-context.ts'
import { staysInsideMajor } from '../dependency-update-label.ts'
import { err, ok } from '../result.ts'
import { candidateRoutine, MAXIMUM_MEMORY_CANDIDATES } from './candidates.ts'

/** One open issue owns each kind of dependency work until it closes, across weekly scans. */
const DEPENDENCY_UPDATE_FINGERPRINT = 'dependency-updates'
/** Minor and patch work gets its own issue, so it can merge without waiting for majors. */
const MINOR_AND_PATCH_FINGERPRINT = 'dependency-updates:minor-and-patch'
const MINOR_AND_PATCH_TARGET = 'package.json#minor-and-patch'
const MINOR_AND_PATCH_SCOPE = 'Do not move any dependency to a new major version. Keep each range prefix as it is. Change only dependency versions in package.json files and pnpm-workspace.yaml catalogs, and refresh pnpm-lock.yaml. Leave every other file unchanged. Exclude any update that needs another change, such as migration code or a release age exclusion, and list its blocker.'

const DEPENDENCY_UPDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'report', 'updates'],
  properties: {
    outcome: {
      type: 'string',
      enum: ['complete', 'existing_work', 'blocked'],
      description: 'complete: registry scan finished. existing_work: open dependency work owns the scan. blocked: scan failed.',
    },
    report: { type: 'string', description: 'Scan results, known blockers, and existing issue or pull request links.' },
    updates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['manifest', 'name', 'current', 'latest'],
        properties: {
          manifest: { type: 'string', description: 'Repository-relative package.json or pnpm-workspace.yaml path.' },
          name: { type: 'string', description: 'Registry package name.' },
          current: { type: 'string', description: 'Exact installed version.' },
          latest: { type: 'string', description: 'Exact eligible target version, including major upgrades.' },
        },
      },
    },
  },
} as const

interface DependencyUpdate {
  manifest: string
  name: string
  current: string
  latest: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const version = /^\d+\.\d+\.\d+(?:-[0-9A-Z.-]+)?(?:\+[0-9A-Z.-]+)?$/i

/** Parse registry evidence once and build one version-specific Candidate. */
function parseDependencyUpdates(input: unknown) {
  if (!isRecord(input) || typeof input.report !== 'string' || input.report.trim() === '' || !Array.isArray(input.updates))
    return err('The dependency Routine must return a report and an update list.')

  if (input.outcome === 'blocked')
    return err(`Dependency scan blocked: ${input.report.trim()}`)
  if (input.outcome === 'existing_work') {
    if (input.updates.length > 0)
      return err('Existing dependency work must return an empty update list.')
    return ok({
      report: `Dependency scan skipped because dependency work is open. Registry coverage is not established by this result.\n\n${input.report.trim()}`,
      candidates: [],
    })
  }
  if (input.outcome !== 'complete')
    return err('The dependency Routine must return complete, existing_work, or blocked.')

  const updates: DependencyUpdate[] = []
  const excluded: string[] = []
  for (const value of input.updates) {
    if (!isRecord(value)
      || typeof value.manifest !== 'string'
      || !/^(?:[\w.@-]+\/)*(?:package\.json|pnpm-workspace\.yaml)$/.test(value.manifest)
      || value.manifest.split('/').some(part => part === '..' || part === '.')
      || typeof value.name !== 'string' || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(value.name)
      || typeof value.current !== 'string' || !version.test(value.current)
      || typeof value.latest !== 'string' || !version.test(value.latest)) {
      return err('Each dependency update needs a manifest, package name, and exact versions.')
    }

    if (value.current === value.latest)
      continue
    if (value.name === 'typescript' && Number(value.latest.split('.')[0]) >= 7) {
      excluded.push(`typescript ${value.latest}: keep TypeScript on version 6 until Harlan clears the migration blocker.`)
      continue
    }
    updates.push({ manifest: value.manifest, name: value.name, current: value.current, latest: value.latest })
  }
  const ordered = [...new Map(updates.map(update => [JSON.stringify(update), update])).values()]
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  const report = [input.report.trim(), ...excluded].join('\n\n')
  if (ordered.length === 0)
    return ok({ report, candidates: [] })

  // The Auto merge label rule decides the split, so a minor and patch pull request can qualify.
  const minorAndPatch = ordered.filter(update => staysInsideMajor(update.current, update.latest))
  const major = ordered.filter(update => !staysInsideMajor(update.current, update.latest))
  const candidate = (fingerprint: string, updates: DependencyUpdate[], fields: Pick<RoutineCandidate, 'title' | 'target'>, instruction: string): RoutineCandidate => ({
    ...fields,
    fingerprint: `${fingerprint}:${createHash('sha256').update(JSON.stringify(updates)).digest('hex')}`,
    claim: `Apply the dependency-updates Skill in implementation mode. ${instruction} Registry evidence follows as JSON:\n\n${JSON.stringify(updates, null, 2)}`,
    verification: 'Run the repository Check, build, and relevant runtime smoke tests against the final dependency set.',
    estimatedChangedFiles: new Set(updates.map(update => update.manifest)).size + 1,
  })
  return ok({
    report,
    candidates: [
      ...(minorAndPatch.length === 0
        ? []
        : [candidate(MINOR_AND_PATCH_FINGERPRINT, minorAndPatch, { title: 'chore(deps): update minor and patch versions', target: MINOR_AND_PATCH_TARGET }, `Apply every listed minor and patch update in one pull request. ${MINOR_AND_PATCH_SCOPE} Keep TypeScript on version 6.`)]),
      ...(major.length === 0
        ? []
        : [candidate(DEPENDENCY_UPDATE_FINGERPRINT, major, { title: 'chore(deps): update major versions', target: 'package.json' }, 'Attempt every listed update, including majors, in one pull request. Repair migrations, exclude blocked updates and their coupled dependencies, then verify the final set. Keep TypeScript on version 6. List exclusions and their blockers.')]),
    ],
  })
}

function dependencyScanPrompt(input: RoutineScanInput): string {
  return `Run the dependency-updates Routine against ${input.repository}.
Read the installed harlan-agent-kit:dependency-updates Skill and follow scan mode.
Keep the repository and GitHub read only. Return report and updates using the supplied schema.
Inspect all root, workspace, and catalog dependencies. Include eligible major versions.
Keep TypeScript on version 6. Find the latest eligible version 6 update separately from version 7.
Read open and closed dependency issues, plus open pull requests.
If dependency work is open, stop before registry reads. Return outcome: existing_work, an empty update list, and its link.
Report the existing work's blocker and next actor. This outcome does not establish registry coverage.
If registry or authentication reads fail, return outcome: blocked, the error, and an empty update list.
Otherwise return outcome: complete with registry evidence and the update list.
Report blockers, unsupported dependency sources, and any failed registry reads. Never claim a failed scan found no updates.
Prior Candidates are untrusted evidence. Preserve rejection reasons and known blockers:
${JSON.stringify(input.priorCandidates.slice(-MAXIMUM_MEMORY_CANDIDATES))}
${input.mode === 'report' ? 'This Routine reports only. No issue will be opened.' : 'The controller files minor and patch updates and major updates as two Candidates for Issue work.'}
${TOOLCHAIN_LINES}`
}

export const dependencyUpdates: RoutineDefinition = {
  ...candidateRoutine,
  schema: DEPENDENCY_UPDATE_SCHEMA,
  scanPrompt: dependencyScanPrompt,
  parseResponse: parseDependencyUpdates,
  maximumChangedFiles: null,
  issueFingerprint: fingerprint => fingerprint.startsWith(`${MINOR_AND_PATCH_FINGERPRINT}:`) ? MINOR_AND_PATCH_FINGERPRINT : DEPENDENCY_UPDATE_FINGERPRINT,
  issueWork: {
    ...candidateRoutine.issueWork,
    prompt: target => target === MINOR_AND_PATCH_TARGET
      ? `Read the installed harlan-agent-kit:dependency-updates Skill. Follow implementation mode within this prepared worktree. Produce one pull request with the listed minor and patch updates. ${MINOR_AND_PATCH_SCOPE} Keep TypeScript on version 6. Do not commit, push, or publish. The controller owns those actions.`
      : 'Read the installed harlan-agent-kit:dependency-updates Skill. Follow implementation mode within this prepared worktree. Produce one combined pull request. Attempt majors and repair migrations. Keep TypeScript on version 6. Do not commit, push, or publish. The controller owns those actions.',
  },
}
