import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { glob } from 'node:fs/promises'
import process from 'node:process'

const bumpType = process.argv[2] as 'patch' | 'minor' | 'major' | undefined

if (!bumpType || !['patch', 'minor', 'major'].includes(bumpType)) {
  console.error('Usage: pnpm release <patch|minor|major>')
  process.exit(1)
}

function bumpVersion(version: string, type: 'patch' | 'minor' | 'major'): string {
  const [major, minor, patch] = version.split('.').map(Number)
  if (type === 'major')
    return `${major + 1}.0.0`
  if (type === 'minor')
    return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

// Get current version from plugin.json
const pluginPath = 'harlan-agent-kit/.claude-plugin/plugin.json'
const marketplacePath = '.claude-plugin/marketplace.json'
const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'))
const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf-8'))
const oldVersion = plugin.version
const newVersion = bumpVersion(oldVersion, bumpType)

console.log(`Bumping ${oldVersion} → ${newVersion}`)

// Update plugin.json
plugin.version = newVersion
writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`)
console.log(`  ✓ ${pluginPath}`)

// Update marketplace.json (sync version in plugins array)
marketplace.plugins[0].version = newVersion
writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`)
console.log(`  ✓ ${marketplacePath}`)

// Update all SKILL.md files (if they have version in frontmatter)
for await (const file of glob('**/skill.md', { nocase: true })) {
  const content = readFileSync(file, 'utf-8')
  const updated = content.replace(
    /^(---[\s\S]*?version:\s*)[\d.]+/m,
    `$1${newVersion}`,
  )
  if (updated !== content) {
    writeFileSync(file, updated)
    console.log(`  ✓ ${file}`)
  }
}

// Git operations
execSync('git add -A')
execSync(`git commit -m "chore: release v${newVersion}"`)
execSync(`git tag v${newVersion}`)
execSync('git push && git push --tags', { stdio: 'inherit' })

console.log(`\nReleased v${newVersion}`)
