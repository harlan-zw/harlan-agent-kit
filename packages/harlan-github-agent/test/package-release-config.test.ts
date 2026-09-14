import { expect, it } from 'vitest'
import { parsePackageReleaseConfig } from '../src/package-release-config.ts'

const input = { manifest: 'package.json', version_files: ['package.json'], tag_prefix: 'v', workflow: 'release.yml', checks: ['test', 'build'] }
it('parses an explicit package release policy', () => {
  expect(parsePackageReleaseConfig(input)).toEqual({ _tag: 'Ok', value: {
    manifest: 'package.json',
    versionFiles: ['package.json'],
    tagPrefix: 'v',
    workflow: 'release.yml',
    checks: ['test', 'build'],
  } })
})
it.each([
  { manifest: '../package.json' },
  { manifest: '/package.json' },
  { manifest: '.github/package.json' },
  { version_files: [] },
  { version_files: ['other.json'] },
  { version_files: ['package.json', '../other.json'] },
  { tag_prefix: 'v;command' },
  { workflow: '../release.yml' },
  { checks: [] },
  { checks: [1] },
])('rejects invalid release configuration: %j', (change) => {
  expect(parsePackageReleaseConfig({ ...input, ...change })._tag).toBe('Err')
})
