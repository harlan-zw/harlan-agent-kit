import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

const script = join(dirname(fileURLToPath(import.meta.url)), 'worktree-claim.sh')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claim-proof-'))
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0)
  const command = (...args: string[]) => spawnSync('bash', [script, ...args, '--path', root], { encoding: 'utf8' })
  const age = () => {
    const directory = join(root, '.git/wolfstar-agent-kit/worktree-claims')
    for (const file of readdirSync(directory).filter((file) => file.endsWith('.json'))) {
      const path = join(directory, file)
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), expires_epoch: 0 }))
    }
  }
  return { root, command, age, close: () => rmSync(root, { recursive: true, force: true }) }
}
it('durable claims survive expiry, ordinary renewal, and foreign release', () => {
  const f = fixture()
  try {
    assert.equal(f.command('acquire', '--session', 'terminal-owned', '--durable').status, 0)
    f.age()
    assert.equal(f.command('acquire', '--session', 'foreign').status, 2)
    assert.equal(f.command('release', '--session', 'foreign').status, 3)
    assert.equal(f.command('acquire', '--session', 'terminal-owned').status, 0)
    f.age()
    assert.equal(f.command('acquire', '--session', 'foreign').status, 2)
    assert.equal(JSON.parse(f.command('list').stdout)[0].session, 'terminal-owned')
    assert.equal(f.command('release', '--session', 'terminal-owned').status, 0)
    assert.equal(f.command('acquire', '--session', 'foreign').status, 0)
  } finally {
    f.close()
  }
})
it('ordinary claims retain lease expiry', () => {
  const f = fixture()
  try {
    assert.equal(f.command('acquire', '--session', 'ordinary').status, 0)
    f.age()
    assert.equal(f.command('acquire', '--session', 'replacement').status, 0)
    assert.equal(JSON.parse(f.command('list').stdout)[0].session, 'replacement')
  } finally {
    f.close()
  }
})
