import { spawn } from 'node:child_process'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const source = process.env.NOTES_DIR || join(homedir(), 'notes')
const target = join(root, '.content')
const accepted = /\.(?:md|png|jpe?g|gif|webp|svg|pdf)$/i
const fingerprints = new Map()
let previousIndex

async function sync() {
  const files = []
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink())
        continue
      const path = join(dir, entry.name)
      if (entry.isDirectory())
        await scan(path)
      else if (entry.isFile() && accepted.test(entry.name))
        files.push({ path, name: relative(source, path), modified: (await stat(path)).mtimeMs })
    }
  }
  await scan(source)
  const present = new Set(files.map(file => file.name))
  for (const name of fingerprints.keys()) {
    if (!present.has(name)) {
      await rm(join(target, 'notes', name))
      fingerprints.delete(name)
    }
  }
  for (const file of files) {
    if (fingerprints.get(file.name) === file.modified)
      continue
    const dest = join(target, 'notes', file.name)
    await mkdir(dirname(dest), { recursive: true })
    await cp(file.path, dest)
    fingerprints.set(file.name, file.modified)
  }
  const entries = []
  for (const file of files.filter(file => file.name.endsWith('.md')).sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name))) {
    const markdown = await readFile(file.path, 'utf8')
    const title = (markdown.match(/^# (.+)$/m)?.[1] || file.name.replace(/\.md$/, '')).replace(/[[\]<>]/g, '')
    const url = `/notes/${file.name.split('/').map(encodeURIComponent).join('/').replace(/\.md$/, '')}`
    entries.push(`- [${title}](${url}) · ${new Date(file.modified).toISOString().slice(0, 10)}`)
  }
  const index = `# Notes\n\nSearch reports and diagrams. Most recently updated first.\n\n${entries.join('\n') || 'No notes yet. Add Markdown files to your notes directory.'}\n`
  const indexPath = join(target, 'index.md')
  if (previousIndex !== index) {
    await writeFile(indexPath, index)
    previousIndex = index
  }
}

async function main() {
  await mkdir(source, { recursive: true })
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await sync()
  const build = process.argv[2] === 'build'
  const args = build ? ['build'] : ['dev', '--host', '127.0.0.1', '--port', process.env.PORT || '4173']
  const child = spawn(join(root, 'node_modules/.bin/vitepress'), args, { cwd: root, stdio: 'inherit' })
  let timer
  if (!build) {
    let syncing = false
    timer = setInterval(() => {
      if (syncing)
        return
      syncing = true
      sync().catch((error) => {
        process.stderr.write(`Notes refresh failed: ${error.message}\n`)
      }).finally(() => { syncing = false })
    }, 2000)
  }
  child.on('error', (error) => {
    throw error
  })
  child.on('exit', (code) => {
    clearInterval(timer)
    process.exitCode = code ?? 1
  })
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      clearInterval(timer)
      child.kill(signal)
    })
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
