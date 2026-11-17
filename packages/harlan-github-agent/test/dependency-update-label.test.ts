import type { DependencyUpdateLabelInput } from '../src/dependency-update-label.ts'
import { describe, expect, it } from 'vitest'
import { dependencyUpdateLabel } from '../src/dependency-update-label.ts'

function manifest(dependencies: Record<string, string>, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ name: 'example', scripts: { build: 'obuild' }, ...extra, dependencies }, null, 2)}\n`
}

function workspace(catalog: Record<string, string>, extra = ''): string {
  return `packages:\n  - packages/*\n${extra}catalog:\n${Object.entries(catalog).map(([name, version]) => `  '${name}': ${version}`).join('\n')}\n`
}

/** A clean root update: one manifest, the workspace catalog, and the lockfile. */
function input(overrides: Partial<DependencyUpdateLabelInput> = {}): DependencyUpdateLabelInput {
  return {
    routines: ['dependency-updates'],
    ownership: 'owned',
    paths: [
      { status: 'M', path: 'package.json' },
      { status: 'M', path: 'pnpm-lock.yaml' },
      { status: 'M', path: 'pnpm-workspace.yaml' },
    ],
    manifests: new Map([
      ['package.json', { before: manifest({ 'h3': '^2.1.0', 'pinned': '1.4.2', '@nuxt/kit': 'catalog:' }), after: manifest({ 'h3': '^2.3.0', 'pinned': '1.4.3', '@nuxt/kit': 'catalog:' }) }],
      ['pnpm-workspace.yaml', { before: workspace({ '@nuxt/kit': '^4.6.1', 'obuild': '^0.4.44' }), after: workspace({ '@nuxt/kit': '^4.6.2', 'obuild': '^0.4.45' }) }],
    ]),
    ...overrides,
  }
}

function withManifest(path: string, before: string, after: string): DependencyUpdateLabelInput {
  const base = input()
  return { ...base, manifests: new Map([...base.manifests, [path, { before, after }]]) }
}

describe('dependency update Auto merge label', () => {
  it('labels minor and patch updates across manifests, catalogs, and the lockfile', () => {
    expect(dependencyUpdateLabel(input())._tag).toBe('Label')
  })

  it.each([
    ['a major version', withManifest('package.json', manifest({ h3: '^2.1.0' }), manifest({ h3: '^3.0.0' })), 'h3 moves from ^2.1.0 to ^3.0.0, a new major version.'],
    ['a 0.x minor version', withManifest('pnpm-workspace.yaml', workspace({ obuild: '^0.4.44' }), workspace({ obuild: '^0.5.0' })), 'obuild moves from ^0.4.44 to ^0.5.0, a new major version.'],
    ['a 0.0.x patch version', withManifest('package.json', manifest({ tiny: '^0.0.3' }), manifest({ tiny: '^0.0.4' })), 'tiny moves from ^0.0.3 to ^0.0.4, a new major version.'],
    ['a catalog reference replaced by a version', withManifest('package.json', manifest({ h3: 'catalog:' }), manifest({ h3: '^2.3.0' })), 'Only a plain x.y.z version can be compared.'],
    ['a prerelease', withManifest('pnpm-workspace.yaml', workspace({ '@nuxt/devtools': '4.0.0-beta.4' }), workspace({ '@nuxt/devtools': '4.0.0-beta.5' })), 'Only a plain x.y.z version can be compared.'],
    ['a widened range', withManifest('package.json', manifest({ pinned: '1.4.2' }), manifest({ pinned: '^1.4.3' })), 'pinned changes its range from 1.4.2 to ^1.4.3.'],
    ['a downgrade', withManifest('package.json', manifest({ h3: '^2.3.0' }), manifest({ h3: '^2.1.0' })), 'h3 moves back from ^2.3.0 to ^2.1.0.'],
    ['an added dependency', withManifest('package.json', manifest({ h3: '^2.1.0' }), manifest({ h3: '^2.1.0', ufo: '^1.6.1' })), 'package.json adds or removes ufo in dependencies.'],
    ['a script change', withManifest('package.json', manifest({ h3: '^2.1.0' }), manifest({ h3: '^2.1.0' }, { scripts: { build: 'tsdown' } })), 'package.json changes scripts.'],
    ['a peer range change', withManifest('package.json', manifest({}, { peerDependencies: { vue: '^3.5.0' } }), manifest({}, { peerDependencies: { vue: '^3.6.0' } })), 'package.json changes peerDependencies.'],
    ['a workspace setting change', withManifest('pnpm-workspace.yaml', workspace({ h3: '^2.1.0' }), workspace({ h3: '^2.1.0' }, 'minimumReleaseAgeExclude:\n  - h3@2.3.0\n')), 'pnpm-workspace.yaml changes minimumReleaseAgeExclude.'],
    ['an unparseable manifest', withManifest('package.json', manifest({ h3: '^2.1.0' }), '{'), 'package.json could not be parsed.'],
  ])('leaves %s for a person', (_case, value, reason) => {
    const decision = dependencyUpdateLabel(value)

    expect(decision._tag).toBe('NoLabel')
    expect(decision.reason).toContain(reason)
  })

  it('compares a named catalog like the default one', () => {
    const before = 'catalogs:\n  vue:\n    vue: ^3.5.43\n'
    const decision = (after: string) => dependencyUpdateLabel(withManifest('pnpm-workspace.yaml', before, after))

    expect(decision('catalogs:\n  vue:\n    vue: ^3.5.44\n')._tag).toBe('Label')
    expect(decision('catalogs:\n  vue:\n    vue: ^4.0.0\n').reason).toContain('vue moves from ^3.5.43 to ^4.0.0, a new major version.')
  })

  it.each([
    ['a source file', input({ paths: [...input().paths, { status: 'M', path: 'src/module.ts' }] }), 'src/module.ts is not a package manifest or lockfile.'],
    ['an added manifest', input({ paths: [...input().paths, { status: 'A', path: 'packages/new/package.json' }] }), 'packages/new/package.json is added, deleted, or changes type.'],
    ['a maintained repository', input({ ownership: 'maintained' }), 'The repository is maintained. Auto merge covers owned repositories only.'],
    ['an issue another Routine filed', input({ routines: ['dependency-updates', 'seo-review'] }), 'did not file'],
    ['a manifest the controller could not read', input({ manifests: new Map() }), 'package.json could not be read.'],
  ])('leaves a pull request with %s for a person', (_case, value, reason) => {
    const decision = dependencyUpdateLabel(value)

    expect(decision._tag).toBe('NoLabel')
    expect(decision.reason).toContain(reason)
  })
})
