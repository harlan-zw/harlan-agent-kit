import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function driftAuditBlock() {
  const contract = readFileSync(join(repoRoot, 'harlan-agent-kit', 'references', 'root-docs.md'), 'utf8')
  const section = contract.split('## Drift audit')[1] ?? ''
  const fence = section.match(/```bash\n([\s\S]*?)```/)
  if (!fence)
    throw new Error('drift audit bash block not found in root-docs.md')
  return fence[1]
}

function runAudit(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'drift-audit-'))
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(dir, name), content)
  try {
    return spawnSync('bash', ['-c', driftAuditBlock()], { cwd: dir, encoding: 'utf8' })
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

it('reports a backticked markdown path that does not exist', () => {
  const run = runAudit({
    'DESIGN.md': '# Design\n\nHistory lives in `docs/design-decisions.md`.\n',
  })
  expect(run.status).toBe(0)
  expect(run.stdout).toContain('DESIGN.md: dead file docs/design-decisions.md')
})

it('still reports a dead code file referenced from a filter doc', () => {
  const run = runAudit({
    'DESIGN.md': '# Design\n\nUtilities live in `lib/main.css`.\n',
  })
  expect(run.status).toBe(0)
  expect(run.stdout).toContain('DESIGN.md: dead file lib/main.css')
})

it('passes with clean stderr when only DESIGN.md exists', () => {
  const run = runAudit({
    'DESIGN.md': '# Design\n\nKeep sections short.\n\n## Colors\n\nOne rule.\n',
  })
  expect(run.status).toBe(0)
  expect(run.stderr).toBe('')
  expect(run.stdout).toBe('')
})

it('still finds a dated amendment in the only filter doc that exists', () => {
  const run = runAudit({
    'GLOSSARY.md': '## Terms\n\nThe beta flag stayed until 2026.\n',
  })
  expect(run.status).toBe(0)
  expect(run.stderr).toBe('')
  expect(run.stdout).toContain('until 2026')
})
