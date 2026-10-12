import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(packageRoot, '.generated')
const cache = process.env.GHOSTTY_BINDINGS_SOURCE_CACHE ?? resolve(homedir(), 'scratch/ghostty-bindings-source')
const pins = {
  web: { repository: 'coder/ghostty-web', commit: '1858a5947767a3e1c9e98dbf53b2ff87fedb2aab', archive: 'ghostty-web.tar.gz', sha256: 'bfa2a5b2ee5a1941a00dd93ba30c2ea3031286e519e588f1661e5a9fc8f8359b' },
  native: { repository: 'ghostty-org/ghostty', commit: '5714ed07a1012573261b7b7e3ed2add9c1504496', archive: 'ghostty.tar.gz', sha256: 'fabdc07412f5fb39835c875c1d07b5d41b724d84364bd5aff70e5fceda5c5f95' },
  zig: { version: '0.15.2', archive: 'zig.tar.xz', sha256: '02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239' },
  wasmSha256: 'b2801977cbd62ac802d781efcc52c3872bb3816491ffa5d3922fabcf9959e939',
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function command(executable: string, args: string[], cwd: string): void {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', maxBuffer: 100_000_000 })
  if (result.error)
    throw result.error
  if (result.stderr.length > 0)
    process.stderr.write(result.stderr)
  if (result.status !== 0)
    throw new Error(`${executable} exited ${result.status}: ${result.stdout}`)
  if (result.stdout.length > 0)
    process.stdout.write(result.stdout)
}

/** Public reads keep the dedicated GitHub identity; failures stop this build. */
function githubArchive(repository: string, commit: string, destination: string): void {
  const result = spawnSync('agent-gh', ['api', `repos/${repository}/tarball/${commit}`], { maxBuffer: 100_000_000 })
  if (result.error)
    throw result.error
  if (result.stderr.length > 0)
    process.stderr.write(result.stderr)
  if (result.status !== 0)
    throw new Error(`Public source download failed: ${repository}`)
  writeFileSync(destination, result.stdout)
}

function archive(filename: string, expected: string, download: (path: string) => void): string {
  const destination = resolve(cache, filename)
  if (!existsSync(destination))
    download(destination)
  if (digest(destination) !== expected)
    throw new Error(`Source checksum mismatch: ${destination}`)
  return destination
}

async function main(): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error('Build Ghostty bindings on Linux x64. Generated WASM runs on other hosts.')
  mkdirSync(cache, { recursive: true })
  mkdirSync(output, { recursive: true })
  const identity = createHash('sha256').update(JSON.stringify(pins)).update(readFileSync(resolve(packageRoot, 'patches/native.patch'))).update(readFileSync(resolve(packageRoot, 'patches/wrapper.patch'))).update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
  const manifestPath = resolve(output, 'build-manifest.json')
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { identity: string, files: Record<string, string> }
    if (manifest.identity === identity && Object.entries(manifest.files).every(([file, hash]) => existsSync(resolve(output, file)) && digest(resolve(output, file)) === hash)) {
      process.stdout.write('Verified Ghostty bindings match the pinned build.\n')
      return
    }
    throw new Error('Generated Ghostty bindings differ. Remove this package .generated directory and rebuild.')
  }
  for (const [name, pin] of [['web', pins.web], ['native', pins.native]] as const) {
    const source = archive(pin.archive, pin.sha256, path => githubArchive(pin.repository, pin.commit, path))
    const directory = resolve(output, name)
    if (existsSync(directory))
      throw new Error(`Incomplete build exists. Remove ${output} before rebuilding.`)
    mkdirSync(directory)
    command('tar', ['-xzf', source, '--strip-components=1', '-C', directory], packageRoot)
  }
  const zigArchive = archive(pins.zig.archive, pins.zig.sha256, path => command('curl', ['-fL', `https://ziglang.org/download/${pins.zig.version}/zig-x86_64-linux-${pins.zig.version}.tar.xz`, '-o', path], packageRoot))
  const toolchain = resolve(cache, `zig-x86_64-linux-${pins.zig.version}`)
  if (!existsSync(toolchain))
    command('tar', ['-xJf', zigArchive, '-C', cache], packageRoot)
  const web = resolve(output, 'web')
  const native = resolve(output, 'native')
  command('patch', ['-p1', '--batch', '-i', resolve(web, 'patches/ghostty-wasm-api.patch')], native)
  command('patch', ['-p1', '--batch', '-i', resolve(packageRoot, 'patches/native.patch')], native)
  command('patch', ['-p1', '--batch', '-i', resolve(packageRoot, 'patches/wrapper.patch')], web)
  command(resolve(toolchain, 'zig'), ['build', 'lib-vt', '-Dtarget=wasm32-freestanding', '-Doptimize=ReleaseSmall'], native)
  const wasm = resolve(native, 'zig-out/bin/ghostty-vt.wasm')
  if (digest(wasm) !== pins.wasmSha256)
    throw new Error('Compiled Ghostty WASM differs from the verified artifact.')
  writeFileSync(resolve(output, 'ghostty-vt.wasm'), readFileSync(wasm))
  await build({ entryPoints: [resolve(web, 'lib/index.ts')], bundle: true, format: 'esm', platform: 'browser', minifyWhitespace: true, outfile: resolve(output, 'ghostty-web.js') })
  await build({ stdin: { contents: `export { CanvasRenderer } from './lib/renderer.ts'; export { Key, KeyAction, Mods } from './lib/types.ts'; export { KEY_MAP as browserKeyMap } from './lib/input-handler.ts';`, resolveDir: web, sourcefile: 'browser-entry.ts' }, bundle: true, format: 'esm', platform: 'browser', minifyWhitespace: true, outfile: resolve(output, 'browser.js') })
  // Package declarations come from the matching published version, with additive repair methods.
  const declarationPath = resolve(dirname(fileURLToPath(import.meta.resolve('ghostty-web'))), 'index.d.ts')
  let types = readFileSync(declarationPath, 'utf8').replaceAll('\r\n', '\n')
  const method = '    getMode(mode: number, isAnsi?: boolean): boolean;'
  if (!types.includes(method))
    throw new Error('Pinned Ghostty declarations changed shape.')
  types = types.replace(method, `    getKittyKeyboardFlags(): number;\n    configureKeyEncoder(encoder: KeyEncoder): void;\n${method}`)
  writeFileSync(resolve(output, 'ghostty-web.d.ts'), types)
  writeFileSync(resolve(output, 'browser.d.ts'), `export { CanvasRenderer, Key, KeyAction, Mods } from './ghostty-web.js';\nimport type { Key } from './ghostty-web.js';\nexport declare const browserKeyMap: Readonly<Record<string, Key>>;\n`)
  for (const name of ['ghostty', 'ghostty-web'])
    writeFileSync(resolve(output, `LICENSE.${name}`), readFileSync(resolve(packageRoot, `LICENSE.${name}`)))
  const files = Object.fromEntries(['ghostty-vt.wasm', 'ghostty-web.js', 'browser.js', 'ghostty-web.d.ts', 'browser.d.ts', 'LICENSE.ghostty', 'LICENSE.ghostty-web'].map(file => [file, digest(resolve(output, file))]))
  writeFileSync(manifestPath, `${JSON.stringify({ identity, pins, files }, null, 2)}\n`)
  process.stdout.write('Built and verified pinned Ghostty WASM, public bindings, and browser renderer.\n')
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
