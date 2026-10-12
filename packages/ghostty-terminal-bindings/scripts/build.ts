import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, version } from 'esbuild'
import { artifactDigests, digest, pins, provenance } from './provenance.ts'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = resolve(packageRoot, '.generated')
const cache = process.env.GHOSTTY_BINDINGS_SOURCE_CACHE ?? resolve(homedir(), 'scratch/ghostty-bindings-source')

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
  if (!existsSync(destination)) {
    const temporary = resolve(mkdtempSync(resolve(cache, 'download-')), filename)
    download(temporary)
    if (digest(temporary) !== expected)
      throw new Error(`Source checksum mismatch: ${temporary}`)
    renameSync(temporary, destination)
  }
  if (digest(destination) !== expected)
    throw new Error(`Source checksum mismatch: ${destination}`)
  return destination
}

async function main(): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error('Build Ghostty bindings on Linux x64. Generated WASM runs on other hosts.')
  if (version !== pins.bundler.version)
    throw new Error('Installed esbuild differs from the pinned source bundler.')
  mkdirSync(cache, { recursive: true })
  const output = mkdtempSync(resolve(cache, 'build-'))
  process.stdout.write(`Building pinned source in ${output}\n`)
  for (const [name, pin] of [['web', pins.web], ['native', pins.native]] as const) {
    const source = archive(pin.archive, pin.sha256, path => githubArchive(pin.repository, pin.commit, path))
    const directory = resolve(output, name)
    mkdirSync(directory)
    command('tar', ['-xzf', source, '--strip-components=1', '-C', directory], packageRoot)
  }
  const zigArchive = archive(pins.zig.archive, pins.zig.sha256, path => command('curl', ['-fL', `https://ziglang.org/download/${pins.zig.version}/zig-x86_64-linux-${pins.zig.version}.tar.xz`, '-o', path], packageRoot))
  const toolchain = resolve(output, `zig-x86_64-linux-${pins.zig.version}`)
  command('tar', ['-xJf', zigArchive, '-C', output], packageRoot)
  const web = resolve(output, 'web')
  const native = resolve(output, 'native')
  command('patch', ['-p1', '--batch', '-i', resolve(web, 'patches/ghostty-wasm-api.patch')], native)
  command('patch', ['-p1', '--batch', '-i', resolve(packageRoot, 'patches/native.patch')], native)
  command('patch', ['-p1', '--batch', '-i', resolve(packageRoot, 'patches/wrapper.patch')], web)
  command(resolve(toolchain, 'zig'), ['build', 'lib-vt', '-Dtarget=wasm32-freestanding', '-Doptimize=ReleaseSmall'], native)
  const wasm = resolve(native, 'zig-out/bin/ghostty-vt.wasm')
  if (digest(wasm) !== artifactDigests['ghostty-vt.wasm'])
    throw new Error('Compiled Ghostty WASM differs from the verified artifact.')
  writeFileSync(resolve(output, 'ghostty-vt.wasm'), readFileSync(wasm))
  await build({ entryPoints: [resolve(web, 'lib/index.ts')], bundle: true, format: 'esm', platform: 'browser', minifyWhitespace: true, outfile: resolve(output, 'ghostty-web.js') })
  await build({ stdin: { contents: `export { CanvasRenderer } from './lib/renderer.ts'; export { Key, KeyAction, Mods } from './lib/types.ts'; export { KEY_MAP as browserKeyMap } from './lib/input-handler.ts';`, resolveDir: web, sourcefile: 'browser-entry.ts' }, bundle: true, format: 'esm', platform: 'browser', minifyWhitespace: true, outfile: resolve(output, 'browser.js') })
  // Package declarations come from the matching published version, with additive repair methods.
  const declarationPath = resolve(dirname(fileURLToPath(import.meta.resolve('ghostty-web'))), 'index.d.ts')
  const published: unknown = JSON.parse(readFileSync(resolve(dirname(declarationPath), '../package.json'), 'utf8'))
  if (typeof published !== 'object' || published === null || !('version' in published) || published.version !== pins.declarations.version)
    throw new Error('Installed Ghostty declarations differ from the pinned published version.')
  let types = readFileSync(declarationPath, 'utf8').replaceAll('\r\n', '\n')
  const method = '    getMode(mode: number, isAnsi?: boolean): boolean;'
  if (!types.includes(method))
    throw new Error('Pinned Ghostty declarations changed shape.')
  types = types.replace(method, `    getKittyKeyboardFlags(): number;\n    configureKeyEncoder(encoder: KeyEncoder): void;\n${method}`)
  writeFileSync(resolve(output, 'ghostty-web.d.ts'), types)
  writeFileSync(resolve(output, 'browser.d.ts'), `export { CanvasRenderer, Key, KeyAction, Mods } from './ghostty-web.js';\nimport type { Key } from './ghostty-web.js';\nexport declare const browserKeyMap: Readonly<Record<string, Key>>;\n`)
  for (const name of ['ghostty', 'ghostty-web'])
    writeFileSync(resolve(output, `LICENSE.${name}`), readFileSync(resolve(packageRoot, `LICENSE.${name}`)))
  // Compare the rebuild with reviewed pins before replacing any checked artifacts.
  for (const [file, expected] of Object.entries(artifactDigests)) {
    if (digest(resolve(output, file)) !== expected)
      throw new Error(`Rebuilt artifact differs from its reviewed checksum: ${file}`)
  }
  mkdirSync(artifacts, { recursive: true })
  for (const file of Object.keys(artifactDigests))
    writeFileSync(resolve(artifacts, file), readFileSync(resolve(output, file)))
  writeFileSync(resolve(artifacts, 'build-manifest.json'), `${JSON.stringify(provenance(packageRoot), null, 2)}\n`)
  process.stdout.write('Built and verified pinned Ghostty WASM, public bindings, and browser renderer.\n')
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
