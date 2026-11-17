import type { DependencyUpdateLabelInput } from '../src/dependency-update-label.ts'
import { describe, expect, it } from 'vitest'
import { dependencyUpdateLabel } from '../src/dependency-update-label.ts'

function manifest(dependencies: Record<string, string>, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ name: 'example', scripts: { build: 'obuild' }, ...extra, dependencies }, null, 2)}\n`
}

function workspace(catalog: Record<string, string>, extra = ''): string {
  return `packages:\n  - packages/*\n${extra}catalog:\n${Object.entries(catalog).map(([name, version]) => `  '${name}': ${version}`).join('\n')}\n`
}

/** A pnpm 9 lockfile with one root importer. A version may carry pnpm's peer suffix. */
function lockfile(dependencies: Record<string, string>, resolution = (name: string, version: string) => `{integrity: sha512-${name}${version}}`, extra = ''): string {
  const entries = Object.entries(dependencies).map(([name, version]) => [name, version.replace(/\(.*$/, '')] as const)
  return `lockfileVersion: '9.0'\n${extra}importers:\n  .:\n    dependencies:\n${Object.entries(dependencies).map(([name, version]) => `      '${name}':\n        specifier: ^${version.replace(/\(.*$/, '')}\n        version: ${version}`).join('\n')}\npackages:\n${entries.map(([name, version]) => `  '${name}@${version}':\n    resolution: ${resolution(name, version)}`).join('\n')}\n`
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
    contents: new Map([
      ['package.json', { before: manifest({ 'h3': '^2.1.0', 'pinned': '1.4.2', '@nuxt/kit': 'catalog:' }), after: manifest({ 'h3': '^2.3.0', 'pinned': '1.4.3', '@nuxt/kit': 'catalog:' }) }],
      ['pnpm-lock.yaml', { before: lockfile({ 'h3': '2.1.0', '@nuxt/kit': '4.6.1(magicast@0.5.1)' }), after: lockfile({ 'h3': '2.3.0', '@nuxt/kit': '4.6.2(magicast@0.5.2)' }) }],
      ['pnpm-workspace.yaml', { before: workspace({ '@nuxt/kit': '^4.6.1', 'obuild': '^0.4.44' }), after: workspace({ '@nuxt/kit': '^4.6.2', 'obuild': '^0.4.45' }) }],
    ]),
    ...overrides,
  }
}

function withManifest(path: string, before: string, after: string): DependencyUpdateLabelInput {
  const base = input()
  return { ...base, contents: new Map([...base.contents, [path, { before, after }]]) }
}

describe('dependency update Auto merge label', () => {
  it('labels minor and patch updates across manifests, catalogs, and the lockfile', () => {
    expect(dependencyUpdateLabel(input())._tag).toBe('Label')
  })

  it('reads the toolchain document pnpm writes before the lockfile', () => {
    const toolchain = (pnpm: string) => `---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    packageManagerDependencies:\n      pnpm:\n        specifier: ${pnpm}\n        version: ${pnpm}\npackages: {}\n---\n`
    const decision = (pnpm: string) => dependencyUpdateLabel(withManifest('pnpm-lock.yaml', toolchain('12.3.4') + lockfile({ h3: '2.1.0' }), toolchain(pnpm) + lockfile({ h3: '2.3.0' })))

    expect(decision('12.3.4')._tag).toBe('Label')
    expect(decision('12.4.0').reason).toBe('pnpm-lock.yaml importer . changes packageManagerDependencies. Only versions in dependencies, devDependencies, optionalDependencies may change.')
  })

  it('labels a lockfile refresh that keeps each direct dependency inside its major', () => {
    const refresh = input({ paths: [{ status: 'M', path: 'pnpm-lock.yaml' }] })

    expect(dependencyUpdateLabel(refresh)._tag).toBe('Label')
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
    ['a version with a leading zero', withManifest('package.json', manifest({ h3: '^2.1.0' }), manifest({ h3: '^2.01.0' })), 'Only a plain x.y.z version can be compared.'],
    ['a lockfile major', withManifest('pnpm-lock.yaml', lockfile({ h3: '2.1.0' }), lockfile({ h3: '3.0.0' })), 'pnpm-lock.yaml importer .: h3 moves from 2.1.0 to 3.0.0, a new major version.'],
    ['a lockfile prerelease', withManifest('pnpm-lock.yaml', lockfile({ h3: '2.1.0' }), lockfile({ h3: '2.2.0-beta.1' })), 'Only a plain x.y.z version can be compared.'],
    ['a lockfile that redirects a package to a tarball', withManifest('pnpm-lock.yaml', lockfile({ h3: '2.1.0' }), lockfile({ h3: '2.1.0' }, () => '{tarball: https://example.com/h3.tgz}')), 'pnpm-lock.yaml resolves h3@2.1.0 from somewhere other than the registry.'],
    ['a lockfile setting change', withManifest('pnpm-lock.yaml', lockfile({ h3: '2.1.0' }), lockfile({ h3: '2.1.0' }, undefined, 'overrides:\n  h3: 2.1.0\n')), 'pnpm-lock.yaml changes overrides.'],
    ['a lockfile without importers', withManifest('pnpm-lock.yaml', 'lockfileVersion: \'9.0\'\n', 'lockfileVersion: \'9.0\'\n'), 'pnpm-lock.yaml has no importers to compare.'],
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
    ['a manifest the controller could not read', input({ contents: new Map() }), 'package.json could not be read.'],
  ])('leaves a pull request with %s for a person', (_case, value, reason) => {
    const decision = dependencyUpdateLabel(value)

    expect(decision._tag).toBe('NoLabel')
    expect(decision.reason).toContain(reason)
  })
})
