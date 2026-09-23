import type { PackageReleaseConfig } from './package-release.ts'
import type { Result } from './result.ts'
import { err, ok } from './result.ts'

export function parsePackageReleaseConfig(value: unknown): Result<PackageReleaseConfig, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return err('Expected a release object.')
  const input = value as Record<string, unknown>
  const safeFile = (path: unknown): path is string => typeof path === 'string'
    && /^[\w.-]+(?:\/[\w.-]+)*\.json$/.test(path) && !path.split('/').includes('..')
    && !path.startsWith('.') && !path.split('/').includes('node_modules')
  const { changelog } = input
  if (changelog !== undefined && (typeof changelog !== 'string' || !/^[\w-]+\.md$/.test(changelog)))
    return err('Release changelog must name a Markdown file at the repository root.')
  const { manifest, version_files: files, tag_prefix: prefix, workflow, checks } = input
  if (!safeFile(manifest) || !manifest.endsWith('package.json'))
    return err('Release manifest must name a package.json file.')
  if (!Array.isArray(files) || files.length === 0 || files.length > 100 || !files.every(safeFile)
    || !files.includes(manifest) || new Set(files).size !== files.length) {
    return err('Release version_files must include unique JSON files and the manifest.')
  }
  if (typeof prefix !== 'string' || !/^[\w-]*v$/.test(prefix))
    return err('Release tag_prefix must end with v.')
  if (typeof workflow !== 'string' || !/^[\w-]+\.ya?ml$/.test(workflow))
    return err('Release workflow must name one workflow file.')
  if (!Array.isArray(checks) || checks.length === 0 || !checks.every(check => typeof check === 'string' && check.trim().length > 0))
    return err('Release checks must name the required check runs.')
  const { credential } = input
  if (credential !== undefined && credential !== 'user')
    return err('Release credential must be user, or omitted to use the repository credential.')
  return ok({
    manifest,
    ...(typeof changelog === 'string' ? { changelog } : {}),
    versionFiles: files,
    tagPrefix: prefix,
    workflow,
    checks: checks as string[],
    credential: credential === 'user' ? { _tag: 'User' } : { _tag: 'Repository' },
  })
}
