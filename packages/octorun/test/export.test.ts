import { describe, expect, it } from 'vitest'
import { normalizeExportManifest, resolveExportDestination } from '../scripts/export.ts'

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
})
