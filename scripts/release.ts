import { execFileSync, execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { glob } from 'node:fs/promises'
import process from 'node:process'

const dryRun = process.argv.includes('--dry-run')
const bumpType = process.argv[2] as 'patch' | 'minor' | 'major' | undefined

if (!bumpType || !['patch', 'minor', 'major'].includes(bumpType)) {
  console.error('Usage: pnpm release <patch|minor|major> [--dry-run]')
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
const codexPluginPath = 'harlan-agent-kit/.codex-plugin/plugin.json'
const marketplacePath = '.claude-plugin/marketplace.json'
const plugin = JSON.parse(readFileSync(pluginPath, 'utf-8'))
const codexPlugin = JSON.parse(readFileSync(codexPluginPath, 'utf-8'))
const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf-8'))
const oldVersion = plugin.version
const newVersion = bumpVersion(oldVersion, bumpType)

// Read the same reachable history that the new tag will contain.
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trimEnd()
const releaseTags = git('tag', '--merged', 'HEAD', '--list', 'v[0-9]*')
const previousTag = releaseTags ? git('describe', '--tags', '--match', 'v[0-9]*', '--abbrev=0', 'HEAD') : undefined
const range = previousTag ? `${previousTag}..HEAD` : 'HEAD'
const fields = git('log', '--reverse', '-z', '--format=%h%x00%s%x00%b', range, '--').split('\0')
const groups = new Map<string, string[]>([
  ['breaking change', []],
  ['feat', []],
  ['fix', []],
  ['chore', []],
])

for (let i = 0; i + 2 < fields.length; i += 3) {
  const [hash, subject, body] = fields.slice(i, i + 3)
  const conventional = subject.match(/^([a-z]+)(?:\([^()]+\))?(!)?: .+/i)
  const breaking = body.match(/^BREAKING[ -]CHANGE: .*/m)
  const type = conventional?.[2] || breaking ? 'breaking change' : conventional?.[1].toLowerCase() ?? 'other'
  const entries = groups.get(type) ?? []
  entries.push(`  • ${subject} (${hash})${breaking ? `\n    ${breaking[0]}` : ''}`)
  groups.set(type, entries)
}

console.log(`\nRelease ${previousTag ?? '(no previous tag)'} → v${newVersion}`)
console.log(`Commits: ${range}`)
for (const [type, entries] of groups) {
  if (entries.length)
    console.log(`\n${type} (${entries.length})\n${entries.join('\n')}`)
}
if (!fields[0])
  console.log(previousTag ? `\nNo commits since ${previousTag}.` : '\nNo commits.')

const uncommitted = git('status', '--short')
if (uncommitted)
  console.log(`\nUncommitted files included by the release:\n${uncommitted}`)

if (dryRun) {
  console.log('\nDry run complete. No files, commits, or tags changed.')
  process.exit(0)
}

console.log(`\nBumping ${oldVersion} → ${newVersion}`)

// Update plugin.json
plugin.version = newVersion
writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`)
console.log(`  ✓ ${pluginPath}`)

// Update .codex-plugin/plugin.json
codexPlugin.version = newVersion
writeFileSync(codexPluginPath, `${JSON.stringify(codexPlugin, null, 2)}\n`)
console.log(`  ✓ ${codexPluginPath}`)

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
