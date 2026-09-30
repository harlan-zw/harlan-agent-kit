import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [source, target] = process.argv.slice(2)
if (!source || !target) {
  console.error('usage: node stage-install.mjs <source-dir> <target-dir>')
  process.exit(1)
}

const workspaceRoot = resolve(source, '../..')

mkdirSync(join(target, '.vitepress'), { recursive: true })
copyFileSync(join(source, 'package.json'), join(target, 'package.json'))
copyFileSync(join(source, 'start.mjs'), join(target, 'start.mjs'))
copyFileSync(join(source, '.vitepress', 'config.mjs'), join(target, '.vitepress', 'config.mjs'))
copyFileSync(join(workspaceRoot, 'pnpm-workspace.yaml'), join(target, 'pnpm-workspace.yaml'))

const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
for (const name of Object.keys(manifest.dependencies)) {
  manifest.dependencies[name] = JSON.parse(readFileSync(join(source, 'node_modules', name, 'package.json'), 'utf8')).version
}
writeFileSync(join(target, 'package.json'), JSON.stringify(manifest, null, 2))
