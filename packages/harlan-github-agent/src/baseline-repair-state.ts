export const BASELINE_REPAIR_LABEL = 'harlan-agent-baseline-repair'
export const BASELINE_REPAIR_MARKER = '<!-- harlan-agent-kit:baseline-repair -->'

export const BASELINE_REPAIR_LABEL_SPEC = {
  name: BASELINE_REPAIR_LABEL,
  color: '8250df',
  description: 'Marks a pull request that repairs default branch CI.',
} as const

export type PullRequestPurpose
  = | { _tag: 'Change' }
    | { _tag: 'BaselineRepair', baseShaPrefix: string }

interface PullRequestPurposeInput {
  actorLogin: string
  authorLogin: string
  body: string
  headRef: string
  headRepository: string
  labels: string[]
  repository: string
}

const baselineBranch = /(?:^|\/)baseline-ci-([a-f\d]{12,64})$/i

/** Derives controller-owned work from GitHub state alone. */
export function pullRequestPurpose(input: PullRequestPurposeInput): PullRequestPurpose {
  const controllerOwned = input.authorLogin.toLowerCase() === input.actorLogin.toLowerCase()
    && input.headRepository.toLowerCase() === input.repository.toLowerCase()
  if (!controllerOwned)
    return { _tag: 'Change' }
  const branch = input.headRef.match(baselineBranch)
  const marked = input.body.includes(BASELINE_REPAIR_MARKER)
    || input.labels.some(label => label.toLowerCase() === BASELINE_REPAIR_LABEL)
    || branch !== null
  return marked && branch?.[1] !== undefined
    ? { _tag: 'BaselineRepair', baseShaPrefix: branch[1].toLowerCase() }
    : { _tag: 'Change' }
}

export function withBaselineRepairMarker(body: string): string {
  const description = body
    .split(/\r?\n/)
    .filter(line => line.trim() !== BASELINE_REPAIR_MARKER)
    .join('\n')
    .trim()
  return `${BASELINE_REPAIR_MARKER}\n${description}`
}
