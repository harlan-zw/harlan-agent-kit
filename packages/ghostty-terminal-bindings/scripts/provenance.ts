import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const pins = {
  web: { repository: 'coder/ghostty-web', commit: '1858a5947767a3e1c9e98dbf53b2ff87fedb2aab', archive: 'ghostty-web.tar.gz', sha256: 'bfa2a5b2ee5a1941a00dd93ba30c2ea3031286e519e588f1661e5a9fc8f8359b' },
  native: { repository: 'ghostty-org/ghostty', commit: '5714ed07a1012573261b7b7e3ed2add9c1504496', archive: 'ghostty.tar.gz', sha256: 'fabdc07412f5fb39835c875c1d07b5d41b724d84364bd5aff70e5fceda5c5f95' },
  zig: { version: '0.15.2', archive: 'zig.tar.xz', sha256: '02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239' },
  declarations: { package: 'ghostty-web', version: '0.4.0' },
  bundler: { package: 'esbuild', version: '0.28.2' },
}
export const artifactDigests = {
  'ghostty-vt.wasm': 'b2801977cbd62ac802d781efcc52c3872bb3816491ffa5d3922fabcf9959e939',
  'ghostty-web.js': '8c4f45074704527a9d70e464529c51eff368312181997b5a7c2f6afff308ecf2',
  'browser.js': '1953b8c25d5c1012b7e2306a565a0d788641cfd9e868e4a4a45aa27675e049db',
  'ghostty-web.d.ts': '861d99221a3c306d2ff326e0697d17d82b2284716ec57c4805cd0ec2264f9648',
  'browser.d.ts': '41bc532f45143dcf1b42bb76da627dd17f74065fed123ca734f83889ca11c63c',
  'LICENSE.ghostty': '386211873e5b7a02f663ae4d7adf96285999f91608f8f9f31fecfd0f4095e6f1',
  'LICENSE.ghostty-web': '5eccd0eeca906db6d661b64dd05e1d4a4b2e49d37d43bbcfd2c8cce4d7832920',
}
export function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
export function provenance(packageRoot: string) {
  const sources = Object.fromEntries(['patches/native.patch', 'patches/wrapper.patch', 'scripts/build.ts', 'scripts/verify.ts', 'scripts/provenance.ts', 'LICENSE.ghostty', 'LICENSE.ghostty-web']
    .map(file => [file, digest(resolve(packageRoot, file))]))
  return { pins, sources, files: artifactDigests }
}

/** Check artifacts against reviewed pins, including the exact source recipe. */
export function verifyArtifacts(packageRoot: string): void {
  const directory = resolve(packageRoot, '.generated')
  const manifest: unknown = JSON.parse(readFileSync(resolve(directory, 'build-manifest.json'), 'utf8'))
  if (JSON.stringify(manifest) !== JSON.stringify(provenance(packageRoot)))
    throw new Error('Ghostty provenance differs from pinned sources. Run build:source after reviewing the source changes.')
  for (const [file, expected] of Object.entries(artifactDigests)) {
    if (digest(resolve(directory, file)) !== expected)
      throw new Error(`Ghostty artifact checksum mismatch: ${file}`)
  }
}
