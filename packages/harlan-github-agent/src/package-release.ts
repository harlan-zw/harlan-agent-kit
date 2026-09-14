import { automatedDisclosure } from './review-comment.ts'

/** One explicitly configured, jointly versioned npm package group. */
export interface PackageReleaseConfig {
  manifest: string
  changelog?: string
  versionFiles: string[]
  tagPrefix: string
  workflow: string
  checks: string[]
}

export interface PackageReleaseInput {
  title: string
  body: string
  merged: boolean
  sourceIncluded: boolean
  sourceSha: string
  mergeSha: string
  previousTag: string
  previousVersion: string
  currentVersion: string
  packageName: string
  commits: string[]
  files: Array<{ filename: string, patch: string }>
  complete: boolean
}

export interface PackageReleasePlan {
  _tag: 'Available'
  bump: 'patch' | 'minor'
  version: string
  previousVersion: string
  previousTag: string
  packageName: string
  sourceSha: string
  mergeSha: string
}

export type PackageReleaseOffer = PackageReleasePlan | { _tag: 'Unavailable', reason: string }

export function stableVersion(value: string): [number, number, number] | null {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value))
    return null
  const parts = value.split('.').map(Number)
  if (parts.some(part => !Number.isSafeInteger(part)))
    return null
  return parts as [number, number, number]
}

export function planPackageRelease(input: PackageReleaseInput): PackageReleaseOffer {
  const unavailable = (reason: string): PackageReleaseOffer => ({ _tag: 'Unavailable', reason })
  if (!input.merged || !input.sourceIncluded)
    return unavailable('The pull request has no unreleased merge on the default branch.')
  if (!input.complete)
    return unavailable('The complete release range could not be read.')
  const previous = stableVersion(input.previousVersion)
  if (previous === null || stableVersion(input.currentVersion) === null)
    return unavailable('Only existing stable releases are supported.')
  const breaking = /^[a-z]+(?:\([^\n]*\))?!:|BREAKING[ -]CHANGE:/im
  if ([input.title, input.body, ...input.commits].some(text => breaking.test(text)))
    return unavailable('Breaking changes require a manual release.')
  // Missing annotations must not hide an obvious public API removal.
  if (input.files.some(file => /\.(?:[cm]?[jt]sx?|vue)$/.test(file.filename)
    && /^-(?!-).*\b(?:export|defineProps|defineEmits)\b/m.test(file.patch))) {
    return unavailable('A public API changed. Check compatibility before releasing.')
  }
  const type = /^(feat|fix|perf)(?:\([^\n]*\))?:/i.exec(input.title)?.[1]?.toLowerCase()
  if (type === undefined)
    return unavailable('This pull request does not need a package release.')
  const types = input.commits.map(commit => /^([a-z]+)(?:\([^\n]*\))?:/i.exec(commit)?.[1]?.toLowerCase())
  if (types.some(type => type === undefined || !['feat', 'fix', 'perf', 'docs', 'chore', 'test', 'style', 'refactor', 'build', 'ci', 'revert'].includes(type)))
    return unavailable('An unreleased commit needs a release classification.')
  const bump = type === 'feat' || types.includes('feat') ? 'minor' : 'patch'
  if (bump === 'minor' && type !== 'feat')
    return unavailable('Unreleased features require minor. Use a merged feature pull request.')
  const version = bump === 'minor' ? `${previous[0]}.${previous[1] + 1}.0` : `${previous[0]}.${previous[1]}.${previous[2] + 1}`
  if (stableVersion(version) === null || ![input.previousVersion, version].includes(input.currentVersion))
    return unavailable('The package version does not match this patch or minor release.')
  return { _tag: 'Available', bump, version, previousVersion: input.previousVersion, previousTag: input.previousTag, packageName: input.packageName, sourceSha: input.sourceSha, mergeSha: input.mergeSha }
}

export const PACKAGE_RELEASE_MARKER = '<!-- harlan-agent-kit:package-release -->'

export function renderPackageRelease(plan: PackageReleasePlan): string {
  return `${PACKAGE_RELEASE_MARKER}\n${automatedDisclosure({ kind: 'status' })}\n\nRelease **${plan.packageName}@${plan.version}** from \`${plan.sourceSha}\`.\nIncludes all unreleased changes since \`${plan.previousTag}\`.\n\n- [ ] Release ${plan.bump}\n`
}

export interface PackageReleaseRequest {
  repository: string
  pullRequestNumber: number
  commentId: number
  requestedBy: string
  commentAuthor: string
  before: string
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** Authority comes from a verified webhook sender, never the comment's author. */
export function releaseRequest(event: string, payload: unknown): PackageReleaseRequest | null {
  const input = record(payload)
  if (event !== 'issue_comment' || input.action !== 'edited')
    return null
  const comment = record(input.comment)
  const before = record(record(input.changes).body).from
  const after = comment.body
  if (typeof before !== 'string' || typeof after !== 'string' || !before.startsWith(PACKAGE_RELEASE_MARKER))
    return null
  const controls = before.match(/^- \[ \] Release (patch|minor)$/gm)
  if (controls?.length !== 1 || (after !== before.replace(controls[0]!, controls[0]!.replace('[ ]', '[x]'))
    && after !== before.replace(controls[0]!, controls[0]!.replace('[ ]', '[X]')))) {
    return null
  }
  const repository = record(input.repository).full_name
  const issue = record(input.issue)
  const requestedBy = record(input.sender).login
  const commentAuthor = record(comment.user).login
  if (typeof repository !== 'string' || typeof issue.number !== 'number' || !Number.isSafeInteger(issue.number)
    || issue.pull_request === undefined || typeof comment.id !== 'number' || !Number.isSafeInteger(comment.id)
    || typeof requestedBy !== 'string' || typeof commentAuthor !== 'string') {
    return null
  }
  return { repository, pullRequestNumber: issue.number, commentId: comment.id, requestedBy, commentAuthor, before }
}

export interface PackageReleaseCommand {
  repository: string
  pullRequestNumber: number
  commentId: number
  requestedBy: string
  bump: 'auto' | 'patch' | 'minor'
}

export function packageReleaseCommand(event: string, payload: unknown): PackageReleaseCommand | null {
  const input = record(payload)
  if (event !== 'issue_comment' || input.action !== 'created')
    return null
  const comment = record(input.comment)
  const match = typeof comment.body === 'string' ? /^do release(?: (patch|minor))?$/i.exec(comment.body.trim()) : null
  const issue = record(input.issue)
  const repository = record(input.repository).full_name
  const requestedBy = record(input.sender).login
  if (match === null || issue.pull_request === undefined || typeof issue.number !== 'number' || !Number.isSafeInteger(issue.number)
    || typeof comment.id !== 'number' || !Number.isSafeInteger(comment.id) || typeof repository !== 'string'
    || typeof requestedBy !== 'string' || record(comment.user).login !== requestedBy) {
    return null
  }
  return { repository, pullRequestNumber: issue.number, commentId: comment.id, requestedBy, bump: match[1]?.toLowerCase() as 'patch' | 'minor' | undefined ?? 'auto' }
}
