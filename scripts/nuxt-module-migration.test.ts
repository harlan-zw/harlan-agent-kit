import { satisfies } from 'semver'
import { describe, expect, it } from 'vitest'
import { migrateManifest } from '../harlan-agent-kit/skills/nuxt-module-migration/scripts/migrate-manifests'

describe('nuxt module support migration', () => {
  it('accepts supported hosts and rejects the old support range', () => {
    const { manifest } = migrateManifest({ peerDependencies: { nuxt: '^3.0.0' } })
    const range = (manifest.peerDependencies as Record<string, string>).nuxt!
    expect(satisfies('4.6.0', range)).toBe(true)
    expect(satisfies('5.0.0', range)).toBe(true)
    expect(satisfies('4.5.2', range)).toBe(false)
    expect(satisfies('3.21.11', range)).toBe(false)
    expect(satisfies('6.0.0', range)).toBe(false)
  })

  it('enforces the real Node floor across supported LTS branches', () => {
    const { manifest } = migrateManifest({ peerDependencies: { nuxt: '*' } })
    const range = (manifest.engines as Record<string, string>).node!
    expect(satisfies('22.22.3', range)).toBe(true)
    expect(satisfies('24.15.0', range)).toBe(true)
    expect(satisfies('26.0.0', range)).toBe(true)
    expect(satisfies('22.22.2', range)).toBe(false)
    expect(satisfies('23.0.0', range)).toBe(false)
    expect(satisfies('24.14.0', range)).toBe(false)
  })

  it('moves Kit into runtime dependencies without changing unrelated contracts', () => {
    const input = { version: '7.2.1', peerDependencies: { nuxt: '*', vue: '^3.5.0' }, devDependencies: { '@nuxt/kit': '^3.0.0' } }
    const { manifest } = migrateManifest(input)
    const kit = (manifest.dependencies as Record<string, string>)['@nuxt/kit']!
    expect(satisfies('4.6.0', kit)).toBe(true)
    expect(satisfies('4.5.2', kit)).toBe(false)
    expect((manifest.devDependencies as Record<string, string>)['@nuxt/kit']).toBeUndefined()
    expect((manifest.peerDependencies as Record<string, string>).vue).toBe(input.peerDependencies.vue)
    expect(manifest.version).toBe(input.version)
    expect(input.devDependencies['@nuxt/kit']).toBe('^3.0.0')
  })

  it('preserves named catalog selection and reports the unresolved update', () => {
    const { manifest, warnings } = migrateManifest({ peerDependencies: { nuxt: '*' }, dependencies: { '@nuxt/kit': 'catalog:nuxt' } })
    expect((manifest.dependencies as Record<string, string>)['@nuxt/kit']).toBe('catalog:nuxt')
    expect(warnings).toEqual(['Set the referenced Kit catalog to ^4.6.0 before installing.'])
  })

  it('rejects fixtures and unrelated packages', () => {
    expect(() => migrateManifest({ private: true, peerDependencies: { nuxt: '*' } })).toThrow('published module')
    expect(() => migrateManifest({ name: 'unrelated-package' })).toThrow('published module')
    expect(() => migrateManifest({ peerDependencies: [] })).toThrow('JSON object')
  })
})
