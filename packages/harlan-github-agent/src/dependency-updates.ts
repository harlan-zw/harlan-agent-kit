import { createHash } from 'node:crypto'
import { err, ok } from './result.ts'

/** One open issue owns dependency work until it closes, across weekly scans. */
export const DEPENDENCY_UPDATE_FINGERPRINT = 'dependency-updates'

export const DEPENDENCY_UPDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'report', 'updates'],
  properties: {
    outcome: { type: 'string', enum: ['complete', 'blocked'] },
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
export function parseDependencyUpdates(input: unknown) {
  if (!isRecord(input) || typeof input.report !== 'string' || input.report.trim() === '' || !Array.isArray(input.updates))
    return err('The dependency Routine must return a report and an update list.')

  if (input.outcome === 'blocked')
    return err(`Dependency scan blocked: ${input.report.trim()}`)
  if (input.outcome !== 'complete')
    return err('The dependency Routine must return complete or blocked.')

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

  const digest = createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
  return ok({
    report,
    candidates: [{
      fingerprint: `${DEPENDENCY_UPDATE_FINGERPRINT}:${digest}`,
      title: 'chore(deps): update dependencies together',
      target: 'package.json',
      claim: `Apply the dependency-updates Skill in implementation mode. Attempt every listed update, including majors, in one pull request. Repair migrations, exclude blocked updates and their coupled dependencies, then verify the final set. Keep TypeScript on version 6. List exclusions and their blockers. Registry evidence follows as JSON:\n\n${JSON.stringify(ordered, null, 2)}`,
      verification: 'Run the repository Check, build, and relevant runtime smoke tests against the final dependency set.',
      estimatedChangedFiles: new Set(ordered.map(update => update.manifest)).size + 1,
    }],
  })
}
