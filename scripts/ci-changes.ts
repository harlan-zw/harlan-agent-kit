import { readFileSync } from 'node:fs'

// Git emits NUL-delimited paths so spaces and newlines cannot hide a change.
const paths = readFileSync(0, 'utf8').split('\0').filter(Boolean)
const code = paths.some((path) => !path.endsWith('.md'))
const instructions =
  code ||
  paths.some((path) => {
    if (/(?:^|\/)(?:AGENTS|CLAUDE|SKILL|GLOSSARY|COPY|DESIGN|VISION)\.md$/.test(path)) return true
    if (path.startsWith('wolfstar-agent-kit/') || path.startsWith('agent-context/') || path.startsWith('.github/'))
      return true
    if (path.startsWith('docs/')) return !path.startsWith('docs/plans/')
    return path !== 'README.md' && path !== 'CHANGELOG.md' && path !== 'LICENSE.md'
  })

process.stdout.write(`code=${code}\ninstructions=${instructions}\n`)
