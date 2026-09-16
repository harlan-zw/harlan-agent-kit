import { isInstructionPath } from './pull-request-triage.ts'

/**
 * How much a wrong merge of this pull request would cost.
 *
 * It routes the merge and never the Review. A Review runs on every tracked
 * pull request whatever this says, because Auto merge has never decided
 * whether a change is read.
 */
export type MergeRisk
  = | { _tag: 'Contained' }
    | { _tag: 'Reviewable', reason: string }
    | { _tag: 'Sensitive', reason: string }

/** One changed file, with the numbers GitHub already returns beside its name. */
export interface PullRequestFile {
  path: string
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  additions: number
  deletions: number
  previousFilename: string | null
}

export interface MergeRiskPolicy {
  maximumChangedFiles: number
  maximumChangedLines: number
  /** Any match is Sensitive. The instruction-file floor applies whatever this holds. */
  sensitivePaths: readonly string[]
  /** When set, a path outside it is Reviewable. Empty allows anything not Sensitive. */
  containedPaths: readonly string[]
  /** A Contained verdict needs a changed test file beside the change. */
  requireTestChange: boolean
}

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i

/** Ranks the three values so the more dangerous of two always wins. */
function severity(risk: MergeRisk): number {
  return risk._tag === 'Contained' ? 0 : risk._tag === 'Reviewable' ? 1 : 2
}

/**
 * Compiles one glob.
 *
 * It supports `**` across directories, `*` within one segment, and literal
 * text. It deliberately pulls in no glob dependency: this decides whether code
 * merges without a person reading it, so the matching stays readable here.
 */
function globToRegExp(pattern: string): RegExp {
  let expression = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!
    if (character !== '*') {
      expression += character.replace(/[.+^${}()|[\]\\?]/, '\\$&')
      continue
    }
    if (pattern[index + 1] !== '*') {
      expression += '[^/]*'
      continue
    }
    if (pattern[index + 2] === '/') {
      // A leading `**/` must also match a path with no directory at all.
      expression += '(?:.*/)?'
      index += 2
      continue
    }
    expression += '.*'
    index += 1
  }
  return new RegExp(`^${expression}$`)
}

export function matchesGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path)
}

/**
 * The deterministic part of the verdict, from paths and counts alone.
 *
 * An Agent cannot argue past this. It is blind to blast radius, so a small
 * change to a widely shared value reads as Contained here. The Agent's claim
 * covers that, and the two combine to the more dangerous answer.
 */
export function mergeRiskFloor(files: readonly PullRequestFile[], policy: MergeRiskPolicy): MergeRisk {
  if (files.length === 0)
    return { _tag: 'Reviewable', reason: 'The pull request changes no file.' }

  // An agent reads these as instructions, so a wrong merge changes how every
  // later agent behaves. That is never one revert commit.
  const instruction = files.find(file => isInstructionPath(file.path))
  if (instruction !== undefined)
    return { _tag: 'Sensitive', reason: `${instruction.path} is read as instructions by an agent.` }

  const sensitive = files.find(file => policy.sensitivePaths.some(pattern => matchesGlob(pattern, file.path)))
  if (sensitive !== undefined)
    return { _tag: 'Sensitive', reason: `${sensitive.path} is a sensitive path for this repository.` }

  if (files.length > policy.maximumChangedFiles)
    return { _tag: 'Reviewable', reason: `The pull request changes ${files.length} files, above ${policy.maximumChangedFiles}.` }

  const lines = files.reduce((total, file) => total + file.additions + file.deletions, 0)
  if (lines > policy.maximumChangedLines)
    return { _tag: 'Reviewable', reason: `The pull request changes ${lines} lines, above ${policy.maximumChangedLines}.` }

  const moved = files.find(file => file.status === 'removed' || file.status === 'renamed')
  if (moved !== undefined)
    return { _tag: 'Reviewable', reason: `${moved.path} is ${moved.status}, so something outside the diff may still reference it.` }

  if (policy.containedPaths.length > 0) {
    const outside = files.find(file => !policy.containedPaths.some(pattern => matchesGlob(pattern, file.path)))
    if (outside !== undefined)
      return { _tag: 'Reviewable', reason: `${outside.path} is outside the paths this repository lets Auto merge cover.` }
  }

  if (policy.requireTestChange && !files.some(file => TEST_PATH.test(file.path)))
    return { _tag: 'Reviewable', reason: 'No test changed beside the change.' }

  return { _tag: 'Contained' }
}

/**
 * Takes the more dangerous of the code's floor and the Agent's claim.
 *
 * So Contained needs both to say Contained. A wrong low needs two independent
 * mistakes, while a wrong high costs one look. The asymmetry is the point,
 * because a wrong low merges code nobody read.
 */
export function combineMergeRisk(floor: MergeRisk, claim: MergeRisk): MergeRisk {
  return severity(claim) > severity(floor) ? claim : floor
}

/** One line naming the verdict and why, for the pull request and the dashboard. */
export function describeMergeRisk(risk: MergeRisk): string {
  return risk._tag === 'Contained' ? 'Contained' : `${risk._tag}: ${risk.reason}`
}
