import type { TerminalArtifact } from './terminal-systemd.ts'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'
import { wasmPath } from 'ghostty-terminal-bindings'
import { verifyTerminalArtifact } from './terminal-systemd.ts'

export async function buildTerminalArtifact(options: { source: string; directory: string }): Promise<TerminalArtifact> {
  const require = createRequire(import.meta.url)
  const nodePtyDirectory = dirname(require.resolve('node-pty/package.json'))
  const wasm = await readFile(wasmPath())
  const wasmDigest = createHash('sha256').update(wasm).digest('hex')
  const nativeDigest = createHash('sha256')
  async function hashDirectory(directory: string) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await hashDirectory(join(directory, entry.name))
      } else if (entry.isFile()) {
        nativeDigest.update(entry.name).update(await readFile(join(directory, entry.name)))
      }
    }
  }
  await hashDirectory(nodePtyDirectory)
  const digest = nativeDigest.digest('hex')
  const result = await build({
    entryPoints: [options.source],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    write: false,
    external: ['node-pty'],
    minifyWhitespace: true,
    banner: { js: `// Ghostty:${wasmDigest}; node-pty:${digest}` },
    logLevel: 'silent',
  })
  const output = result.outputFiles?.[0]
  if (!output) throw new Error('Terminal helper build produced no artifact')
  const helperDigest = createHash('sha256').update(output.contents).digest('hex')
  const directory = join(options.directory, helperDigest)
  const artifact = {
    entry: join(directory, 'terminal-helper.mjs'),
    digest: helperDigest,
    wasm: join(directory, 'ghostty-vt.wasm'),
    wasmDigest,
  }
  await mkdir(options.directory, { recursive: true, mode: 0o700 })
  const existing = await readFile(artifact.entry).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return null
    throw cause
  })
  if (existing) {
    await verifyTerminalArtifact(artifact)
    return artifact
  }
  const temporary = join(options.directory, `${helperDigest}.${randomUUID()}.tmp`)
  await mkdir(join(temporary, 'node_modules'), { recursive: true, mode: 0o700 })
  await writeFile(join(temporary, 'terminal-helper.mjs'), output.contents, {
    mode: 0o500,
  })
  await writeFile(join(temporary, 'ghostty-vt.wasm'), wasm, { mode: 0o400 })
  await cp(nodePtyDirectory, join(temporary, 'node_modules', 'node-pty'), {
    recursive: true,
    dereference: true,
  })
  await rename(temporary, directory).catch(async (cause: NodeJS.ErrnoException) => {
    if (cause.code !== 'EEXIST' && cause.code !== 'ENOTEMPTY') throw cause
    // Concurrent builders may publish the identical immutable artifact first.
    await rm(temporary, { recursive: true })
  })
  await verifyTerminalArtifact(artifact)
  return artifact
}
