import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { artifactDigests, digest, provenance, verifyArtifacts } from '../scripts/provenance.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures: string[] = []
function fixture(): string {
  const scratch = resolve(homedir(), 'scratch')
  mkdirSync(scratch, { recursive: true })
  const directory = mkdtempSync(resolve(scratch, 'ghostty-provenance-test-'))
  fixtures.push(directory)
  for (const file of [
    ...Object.keys(provenance(root).sources),
    ...Object.keys(artifactDigests).map((name) => `.generated/${name}`),
    '.generated/build-manifest.json',
  ]) {
    mkdirSync(dirname(resolve(directory, file)), { recursive: true })
    copyFileSync(resolve(root, file), resolve(directory, file))
  }
  return directory
}
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true })
})
describe('offline Ghostty provenance verification', () => {
  it('accepts reviewed artifacts without source downloads', () => {
    expect(() => verifyArtifacts(fixture())).not.toThrow()
  })
  it('rejects changed source patches even with unchanged artifacts', () => {
    const directory = fixture()
    appendFileSync(resolve(directory, 'patches/native.patch'), '\nchanged\n')
    expect(() => verifyArtifacts(directory)).toThrow('provenance differs')
  })
  it('rejects a corrupted WASM artifact', () => {
    const directory = fixture()
    writeFileSync(resolve(directory, '.generated/ghostty-vt.wasm'), new Uint8Array([0, 1, 2]))
    expect(() => verifyArtifacts(directory)).toThrow('artifact checksum mismatch: ghostty-vt.wasm')
  })
  it('rejects changed wrapper hashes declared only by the manifest', () => {
    const directory = fixture()
    const wrapper = resolve(directory, '.generated/browser.js')
    appendFileSync(wrapper, '\nchanged\n')
    const manifest = JSON.parse(readFileSync(resolve(directory, '.generated/build-manifest.json'), 'utf8')) as {
      files: Record<string, string>
    }
    manifest.files['browser.js'] = digest(wrapper)
    writeFileSync(resolve(directory, '.generated/build-manifest.json'), JSON.stringify(manifest))
    expect(() => verifyArtifacts(directory)).toThrow('provenance differs')
  })
})
