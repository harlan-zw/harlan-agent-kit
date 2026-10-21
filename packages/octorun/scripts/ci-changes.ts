import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function shouldCheckChanges(paths: string[]): boolean {
  const instructions = /(?:^|\/)(?:AGENTS|CLAUDE|GLOSSARY|COPY|VISION|SKILL)\.md$/i
  return paths.some(path => path.length > 0 && (!path.endsWith('.md') || instructions.test(path) || path.startsWith('.github/') || path.startsWith('agent-context/')))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath)
    throw new Error('GITHUB_EVENT_PATH is required.')
  const event = JSON.parse(readFileSync(eventPath, 'utf8')) as { before?: string, pull_request?: { base?: { sha?: string }, head?: { sha?: string } } }
  const base = event.pull_request?.base?.sha ?? event.before ?? ''
  const head = event.pull_request?.head?.sha ?? process.env.GITHUB_SHA ?? ''
  if (!/^[a-f0-9]{40,64}$/.test(head))
    throw new Error('GitHub did not provide a valid head commit.')
  const files = !/^[a-f0-9]{40,64}$/.test(base) || /^0+$/.test(base)
    ? execFileSync('git', ['ls-tree', '-r', '--name-only', head], { encoding: 'utf8' })
    : execFileSync('git', ['diff', '--name-only', base, head, '--'], { encoding: 'utf8' })
  process.stdout.write(`code=${shouldCheckChanges(files.split('\n'))}\n`)
}
