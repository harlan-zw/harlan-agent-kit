import { describe, expect, it } from 'vitest'
import { shouldCheckChanges } from '../scripts/ci-changes.ts'
import { normalizeExportManifest, pruneExportLock, resolveExportDestination } from '../scripts/export.ts'

describe('standalone source export', () => {
  it('pins catalog dependencies and provides independent package commands', () => {
    expect(normalizeExportManifest({ name: '@harlan-zw/octorun', version: '0.1.0', dependencies: { yaml: 'catalog:' }, devDependencies: { typescript: 'catalog:' } }, { 'yaml': '2.9.1', 'typescript': '6.0.3', 'eslint': '10.12.0', '@antfu/eslint-config': '9.5.1' }, 'pnpm@11.22.0')).toMatchObject({ _tag: 'Ok', value: { name: '@harlan-zw/octorun', dependencies: { yaml: '2.9.1' }, devDependencies: { 'typescript': '6.0.3', 'eslint': '10.12.0', '@antfu/eslint-config': '9.5.1' }, scripts: { check: 'pnpm lint && pnpm typecheck && pnpm test:run && pnpm build' }, packageManager: 'pnpm@11.22.0' } })
  })

  it('rejects unresolved catalogs and local workspace dependencies', () => {
    expect(normalizeExportManifest({ name: 'octorun', version: '0.1.0', dependencies: { yaml: 'catalog:' } }, {}, 'pnpm@11.22.0')).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
    expect(normalizeExportManifest({ name: 'octorun', version: '0.1.0', dependencies: { private: 'workspace:*' } }, { private: '1.0.0' }, 'pnpm@11.22.0')).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
  })

  it('keeps export writes outside the source workspace', () => {
    expect(resolveExportDestination('/work/project', '/work/project/packages/octorun', '/scratch/octorun')).toEqual({ _tag: 'Ok', value: '/scratch/octorun' })
    expect(resolveExportDestination('/work/project', '/work/project/packages/octorun', '/work/project/output')).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
    expect(resolveExportDestination('/work/project', '/work/project/packages/octorun', '/work/project')).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
  })

  it('checks agent instructions while skipping ordinary Markdown changes', () => {
    expect(shouldCheckChanges(['README.md', 'docs/quickstart.md'])).toBe(false)
    for (const path of ['AGENTS.md', 'CLAUDE.md', 'GLOSSARY.md', 'COPY.md', 'skills/example/SKILL.md', '.github/PULL_REQUEST_TEMPLATE.md', 'agent-context/context.md'])
      expect(shouldCheckChanges([path])).toBe(true)
    expect(shouldCheckChanges(['README.md', 'src/index.ts'])).toBe(true)
  })

  it('exports only the resolved dependency graph of the standalone package', () => {
    const importer = { dependencies: { yaml: { specifier: '2.9.1', version: '2.9.1' } } }
    const lock = { lockfileVersion: '9.0', settings: {}, packages: { 'yaml@2.9.1': { resolution: { integrity: 'yaml-integrity' } }, 'helper@1.0.0': { resolution: { integrity: 'helper-integrity' } }, 'unrelated@1.0.0': { resolution: { integrity: 'unrelated-integrity' } } }, snapshots: { 'yaml@2.9.1': { dependencies: { helper: '1.0.0' } }, 'helper@1.0.0': {}, 'unrelated@1.0.0': {} } }
    expect(pruneExportLock(lock, importer)).toEqual({ _tag: 'Ok', value: { lockfileVersion: '9.0', settings: {}, importers: { '.': importer }, packages: { 'yaml@2.9.1': lock.packages['yaml@2.9.1'], 'helper@1.0.0': lock.packages['helper@1.0.0'] }, snapshots: { 'yaml@2.9.1': lock.snapshots['yaml@2.9.1'], 'helper@1.0.0': {} } } })
  })
})
