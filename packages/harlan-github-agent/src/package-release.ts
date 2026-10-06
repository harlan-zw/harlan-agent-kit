import ts from 'typescript'
import { automatedDisclosure } from './review-comment.ts'

/**
 * Which GitHub credential writes a package release.
 *
 * `Repository` uses the credential discovery chose for the repository.
 * `User` always uses Harlan's own token, even where the App is installed.
 * A maintained repository must opt in with `User`, because a release there
 * speaks for Harlan and never for the App.
 */
export type PackageReleaseCredential = { _tag: 'Repository' } | { _tag: 'User' }

/** One explicitly configured, jointly versioned npm package group. */
export interface PackageReleaseConfig {
  manifest: string
  changelog?: string
  versionFiles: string[]
  tagPrefix: string
  workflow: string
  checks: string[] | 'all'
  credential: PackageReleaseCredential
}

/** Owned repositories under one checkout root may inherit this policy. */
export interface PackageReleaseDefaults {
  owner: string
  checkoutRoot: string
  policy: PackageReleaseConfig
}

export interface PackageReleaseInput {
  title: string
  body: string
  merged: boolean
  sourceIncluded: boolean
  sourceSha: string
  mergeSha: string
  headSha: string
  previousTag: string
  previousVersion: string
  currentVersion: string
  packageName: string
  commits: string[]
  files: Array<{ filename: string, patch: string, source?: { before: string, after: string } }>
  complete: boolean
}

interface PackageReleaseVersion {
  bump: 'patch' | 'minor'
  version: string
  previousVersion: string
  previousTag: string
  packageName: string
  headSha: string
}

export type PackageReleasePlan = PackageReleaseVersion & (
  | { _tag: 'Available', sourceSha: string, mergeSha: string }
  | { _tag: 'BeforeMerge' }
)

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
  return classifyPackageRelease(input, { _tag: 'Available', sourceSha: input.sourceSha, mergeSha: input.mergeSha })
}

export function planPackageReleaseBeforeMerge(input: Omit<PackageReleaseInput, 'merged' | 'sourceIncluded' | 'sourceSha' | 'mergeSha'>): PackageReleaseOffer {
  return classifyPackageRelease(input, { _tag: 'BeforeMerge' })
}

function hasIncompatibleDeclaration(file: PackageReleaseInput['files'][number]): boolean {
  if (!/^-(?!-).*\b(?:export|defineProps|defineEmits)\b/m.test(file.patch))
    return false
  // Complete, pinned files preserve declaration scope and inferred return behavior.
  if (file.source === undefined || /\.vue$/.test(file.filename) || /\b(?:defineProps|defineEmits)\b/.test(file.patch))
    return true
  const printer = ts.createPrinter()
  if ([file.source.before, file.source.after].some(source => ts.transpileModule(source, { fileName: file.filename, reportDiagnostics: true }).diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)))
    return true
  const before = ts.createSourceFile(file.filename, file.source.before, ts.ScriptTarget.Latest, true)
  const after = ts.createSourceFile(file.filename, file.source.after, ts.ScriptTarget.Latest, true)
  const exported = (source: ts.SourceFile) => source.statements.filter(node => ts.isExportDeclaration(node) || ts.isExportAssignment(node)
    || (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)))
  const print = (node: ts.Node, source: ts.SourceFile) => printer.printNode(ts.EmitHint.Unspecified, node, source)
  const returnsVoid = (body: ts.Block) => {
    let voidOnly = true
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node))
        return
      if ((ts.isReturnStatement(node) && node.expression !== undefined) || ts.isYieldExpression(node))
        voidOnly = false
      ts.forEachChild(node, visit)
    }
    visit(body)
    return voidOnly
  }
  if (exported(before).length === 0)
    return true
  return exported(before).some((old) => {
    if (!ts.isFunctionDeclaration(old) || old.name === undefined)
      return !exported(after).some(node => print(node, after) === print(old, before))
    const identity = (node: ts.FunctionDeclaration, source: ts.SourceFile) => JSON.stringify([
      node.name?.text,
      node.asteriskToken?.kind,
      node.modifiers?.map(modifier => print(modifier, source)),
      node.typeParameters?.map(parameter => print(parameter, source)),
      node.type === undefined ? null : print(node.type, source),
    ])
    return !exported(after).some((node) => {
      if (!ts.isFunctionDeclaration(node) || identity(old, before) !== identity(node, after)
        || node.parameters.length < old.parameters.length
        || !old.parameters.every((parameter, index) => print(parameter, before) === print(node.parameters[index]!, after))
        || !node.parameters.slice(old.parameters.length).every(parameter => parameter.questionToken !== undefined || parameter.initializer !== undefined)) {
        return false
      }
      if (old.body === undefined || node.body === undefined)
        return old.body === node.body
      return old.type !== undefined || (old.parameters.length === node.parameters.length && print(old.body, before) === print(node.body, after))
        || (returnsVoid(old.body) && returnsVoid(node.body))
    })
  })
}

function classifyPackageRelease(input: Omit<PackageReleaseInput, 'merged' | 'sourceIncluded' | 'sourceSha' | 'mergeSha'>, phase: { _tag: 'BeforeMerge' } | { _tag: 'Available', sourceSha: string, mergeSha: string }): PackageReleaseOffer {
  const unavailable = (reason: string): PackageReleaseOffer => ({ _tag: 'Unavailable', reason })
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
    && hasIncompatibleDeclaration(file))) {
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
    return unavailable('Unreleased features require minor. Use a feature pull request.')
  const version = bump === 'minor' ? `${previous[0]}.${previous[1] + 1}.0` : `${previous[0]}.${previous[1]}.${previous[2] + 1}`
  if (stableVersion(version) === null || ![input.previousVersion, version].includes(input.currentVersion))
    return unavailable('The package version does not match this patch or minor release.')
  return { ...phase, bump, version, previousVersion: input.previousVersion, previousTag: input.previousTag, packageName: input.packageName, headSha: input.headSha }
}

export const PACKAGE_RELEASE_MARKER = '<!-- harlan-agent-kit:package-release -->'

export function renderPackageRelease(plan: PackageReleasePlan, selected = false, commentControls = true): string {
  if (!commentControls) {
    const timing = plan._tag === 'BeforeMerge' ? ' after this pull request merges and default branch checks pass' : ` from \`${plan.sourceSha}\``
    const selection = selected ? '\nRelease selected. Waiting for this pull request to merge.\n' : `\nComment \`do release ${plan.bump}\` to request this release.\n`
    return `${PACKAGE_RELEASE_MARKER}\n${automatedDisclosure({ kind: 'status' })}\n\nRelease **${plan.packageName}@${plan.version}**${timing}.\nIncludes all unreleased changes since \`${plan.previousTag}\`.\n${selection}`
  }
  if (plan._tag === 'BeforeMerge') {
    return `${PACKAGE_RELEASE_MARKER}\n${automatedDisclosure({ kind: 'status' })}\n\nRelease **${plan.packageName}@${plan.version}** after this pull request merges and default branch checks pass.\nIncludes all unreleased changes since \`${plan.previousTag}\`.\nSelection applies to head \`${plan.headSha}\`. A changed head or release version clears it.\nClear the checkbox to cancel before merge.\n\n- [${selected ? 'x' : ' '}] Release ${plan.bump} after merge\n`
  }
  return `${PACKAGE_RELEASE_MARKER}\n${automatedDisclosure({ kind: 'status' })}\n\nRelease **${plan.packageName}@${plan.version}** from \`${plan.sourceSha}\`.\nIncludes all unreleased changes since \`${plan.previousTag}\`.\n\n- [ ] Release ${plan.bump}\n`
}

export interface PackageReleaseRequest {
  repository: string
  pullRequestNumber: number
  commentId: number
  requestedBy: string
  commentAuthor: string
  before: string
  selected: boolean
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
  const controls = [...before.matchAll(/^- \[([ xX])\] Release (patch|minor)( after merge)?$/gm)]
  const control = controls[0]
  if (controls.length !== 1 || control === undefined)
    return null
  const selected = control[1] === ' '
  if (!selected && control[3] === undefined)
    return null
  const next = selected ? ['x', 'X'] : [' ']
  if (!next.some(mark => after === before.replace(control[0], control[0].replace(/\[[ x]\]/i, `[${mark}]`))))
    return null
  const repository = record(input.repository).full_name
  const issue = record(input.issue)
  const requestedBy = record(input.sender).login
  const commentAuthor = record(comment.user).login
  if (typeof repository !== 'string' || typeof issue.number !== 'number' || !Number.isSafeInteger(issue.number)
    || issue.pull_request === undefined || typeof comment.id !== 'number' || !Number.isSafeInteger(comment.id)
    || typeof requestedBy !== 'string' || typeof commentAuthor !== 'string') {
    return null
  }
  return { repository, pullRequestNumber: issue.number, commentId: comment.id, requestedBy, commentAuthor, before, selected }
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
