import type { RepositoryOwnership, RoutineName } from './types.ts'
import { isDeepStrictEqual } from 'node:util'
import { parse as parseYaml } from 'yaml'

/**
 * Whether the controller labels a dependency update for Auto merge.
 *
 * It reads the published commit, never the Agent's description of it. A label
 * still needs a READY Review at the bar for a labelled pull request.
 */
export type DependencyUpdateLabel
  = | { _tag: 'Label', reason: string }
    | { _tag: 'NoLabel', reason: string }

/** One path in the published diff, with Git's name-status letter. */
export interface PublishedPath {
  path: string
  status: string
}

export interface DependencyUpdateLabelInput {
  /** The Routine that filed each issue the pull request closes, or null when no Routine filed it. */
  routines: readonly (RoutineName | null)[]
  ownership: RepositoryOwnership
  paths: readonly PublishedPath[]
  /** Both sides of each modified manifest and lockfile, keyed by path. */
  contents: ReadonlyMap<string, { before: string, after: string }>
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies']
const CATALOG_FIELDS = ['catalog', 'catalogs']
const PLAIN_RANGE = /^([~^]?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** A manifest or lockfile. Its content decides the label, so the caller reads both sides of it. */
export function isDependencyFile(path: string): boolean {
  const name = fileName(path)
  return name === 'package.json' || name === 'pnpm-workspace.yaml' || name === 'pnpm-lock.yaml'
}

/** Why one version change needs a person, or null when it stays inside its major. */
function versionChange(name: string, before: unknown, after: unknown): string | null {
  const from = typeof before === 'string' ? PLAIN_RANGE.exec(before) : null
  const to = typeof after === 'string' ? PLAIN_RANGE.exec(after) : null
  if (from === null || to === null)
    return `${name} changes from ${JSON.stringify(before)} to ${JSON.stringify(after)}. Only a plain x.y.z version can be compared.`
  if (from[1] !== to[1])
    return `${name} changes its range from ${before} to ${after}.`
  const old = from.slice(2).map(Number)
  const next = to.slice(2).map(Number)
  const changed = next.findIndex((part, index) => part !== old[index])
  if (changed === -1)
    return null
  if (next[changed]! < old[changed]!)
    return `${name} moves back from ${before} to ${after}.`
  // A caret range holds its first nonzero part, so 0.x minor and 0.0.x patch count as major.
  const nonzero = old.findIndex(part => part !== 0)
  return changed <= (nonzero === -1 ? 2 : nonzero)
    ? `${name} moves from ${before} to ${after}, a new major version.`
    : null
}

/** Whether a version move needs no person: forward, the same prefix, and inside its major. */
export function staysInsideMajor(before: string, after: string): boolean {
  return versionChange('', before, after) === null
}

function dependencyMapChange(path: string, field: string, before: unknown, after: unknown): string | null {
  if (before === undefined && after === undefined)
    return null
  if (!isRecord(before) || !isRecord(after))
    return `${path} adds, removes, or reshapes ${field}.`
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!Object.hasOwn(before, name) || !Object.hasOwn(after, name))
      return `${path} adds or removes ${name} in ${field}.`
    const reason = before[name] === after[name] ? null : versionChange(name, before[name], after[name])
    if (reason !== null)
      return `${path}: ${reason}`
  }
  return null
}

function catalogsChange(path: string, before: unknown, after: unknown): string | null {
  if (before === undefined && after === undefined)
    return null
  if (!isRecord(before) || !isRecord(after))
    return `${path} adds, removes, or reshapes catalogs.`
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!Object.hasOwn(before, name) || !Object.hasOwn(after, name))
      return `${path} adds or removes the ${name} catalog.`
    const reason = dependencyMapChange(path, `catalogs.${name}`, before[name], after[name])
    if (reason !== null)
      return reason
  }
  return null
}

function otherFieldChange(path: string, before: Record<string, unknown>, after: Record<string, unknown>, versionFields: readonly string[]): string | null {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => !versionFields.includes(key))
    .find(key => !isDeepStrictEqual(before[key], after[key]))
  return changed === undefined ? null : `${path} changes ${changed}. Only versions in ${versionFields.join(', ')} may change.`
}

function parseManifest(path: string, text: string): Record<string, unknown> | null {
  try {
    const value: unknown = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text)
    return isRecord(value) ? value : null
  }
  catch {
    // The caller names the unreadable file as the reason for no label.
    return null
  }
}

/** pnpm writes peers after the version in parentheses, so a peer change alone is not a version move. */
function resolvedVersions(dependencies: unknown): unknown {
  if (!isRecord(dependencies))
    return dependencies
  return Object.fromEntries(Object.entries(dependencies).map(([name, entry]) =>
    [name, isRecord(entry) && typeof entry.version === 'string' ? entry.version.replace(/\(.*$/, '') : entry]))
}

/** A refresh can move a direct dependency without a manifest change, so each importer's resolved versions count. */
function lockfileChange(path: string, before: Record<string, unknown>, after: Record<string, unknown>): string | null {
  if (!isRecord(before.importers) || !isRecord(after.importers))
    return `${path} has no importers to compare.`
  const old = before.importers
  const next = after.importers
  for (const importer of [...new Set([...Object.keys(old), ...Object.keys(next)])].sort()) {
    const from = old[importer]
    const to = next[importer]
    if (!isRecord(from) || !isRecord(to))
      return `${path} adds or removes the ${importer} importer.`
    for (const field of DEPENDENCY_FIELDS) {
      const reason = dependencyMapChange(`${path} importer ${importer}`, field, resolvedVersions(from[field]), resolvedVersions(to[field]))
      if (reason !== null)
        return reason
    }
  }
  return null
}

function dependencyFileChange(path: string, before: string, after: string): string | null {
  const old = parseManifest(path, before)
  const next = parseManifest(path, after)
  if (old === null || next === null)
    return `${path} could not be parsed.`
  if (fileName(path) === 'pnpm-lock.yaml')
    return lockfileChange(path, old, next)
  if (fileName(path) === 'package.json') {
    for (const field of DEPENDENCY_FIELDS) {
      const reason = dependencyMapChange(path, field, old[field], next[field])
      if (reason !== null)
        return reason
    }
    return otherFieldChange(path, old, next, DEPENDENCY_FIELDS)
  }
  return dependencyMapChange(path, 'catalog', old.catalog, next.catalog)
    ?? catalogsChange(path, old.catalogs, next.catalogs)
    ?? otherFieldChange(path, old, next, CATALOG_FIELDS)
}

/**
 * Labels a dependency update only when it holds no judgement.
 *
 * Every issue came from the dependency-updates Routine, the repository is
 * owned, and the diff only moves declared and resolved versions inside their major.
 */
export function dependencyUpdateLabel(input: DependencyUpdateLabelInput): DependencyUpdateLabel {
  if (input.routines.length === 0 || input.routines.some(routine => routine !== 'dependency-updates'))
    return { _tag: 'NoLabel', reason: 'The pull request closes an issue the dependency-updates Routine did not file.' }
  if (input.ownership !== 'owned')
    return { _tag: 'NoLabel', reason: `The repository is ${input.ownership}. Auto merge covers owned repositories only.` }
  if (input.paths.length === 0)
    return { _tag: 'NoLabel', reason: 'The pull request changes no file.' }
  for (const { path, status } of input.paths) {
    if (!isDependencyFile(path))
      return { _tag: 'NoLabel', reason: `${path} is not a package manifest or lockfile.` }
    if (status !== 'M')
      return { _tag: 'NoLabel', reason: `${path} is added, deleted, or changes type.` }
    const content = input.contents.get(path)
    const reason = content === undefined ? `${path} could not be read.` : dependencyFileChange(path, content.before, content.after)
    if (reason !== null)
      return { _tag: 'NoLabel', reason }
  }
  return { _tag: 'Label', reason: 'Every changed file is a package manifest or lockfile, and every version stays inside its major.' }
}
