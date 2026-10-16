import { copyFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

async function main() {
  const output = resolve(process.argv[2] ?? 'emergency-dist')
  await mkdir(output, { recursive: true })
  await build({ entryPoints: [new URL('../src/emergency-broker-cli.ts', import.meta.url).pathname], outfile: `${output}/emergency-broker.mjs`, bundle: true, platform: 'node', target: 'node22', format: 'esm', banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } })
  for (const name of ['hogwild-emergency-broker.service', 'hogwild-emergency-broker.socket'])
    await copyFile(new URL(name, import.meta.url), `${output}/${name}`)
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
