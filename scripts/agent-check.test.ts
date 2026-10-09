import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parseCheckPlan, runCheckPlan } from './agent-check.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-check-test-'))
  roots.push(root)
  return root
}

it('keeps the check exit and complete stdout and stderr', async () => {
  const root = await fixture()
  const output = 'diagnostic\n'.repeat(20_000)
  const result = await runCheckPlan({ prerequisites: [], check: [process.execPath, '-e', 'process.stdout.write("diagnostic\\n".repeat(20000)); process.stderr.write("original failure\\n"); process.exitCode = 7'], logDirectory: root }, root)
  expect(result.outcome).toEqual({ _tag: 'Exited', exitCode: 7 })
  expect(await readFile(result.commands[0]!.log, 'utf8')).toBe(`${output}original failure\n`)
})

it('stops before the check when a declared prerequisite fails', async () => {
  const root = await fixture()
  const result = await runCheckPlan({ prerequisites: [[process.execPath, '-e', 'process.exitCode = 9']], check: [process.execPath, '-e', 'throw new Error("must not run")'], logDirectory: root }, root)
  expect(result.commands.map(command => command.argv)).toEqual([[process.execPath, '-e', 'process.exitCode = 9']])
  expect(result.outcome).toEqual({ _tag: 'Exited', exitCode: 9 })
})

it('runs prerequisites in order and passes arguments without shell expansion', async () => {
  const root = await fixture()
  const result = await runCheckPlan({ prerequisites: [[process.execPath, '-e', 'require("node:fs").writeFileSync("prepared", "ready")']], check: [process.execPath, '-e', 'process.stdout.write(require("node:fs").readFileSync("prepared", "utf8") + process.argv[1])', '$(false) | tail'], logDirectory: root }, root)
  expect(result.outcome).toEqual({ _tag: 'Exited', exitCode: 0 })
  expect(await readFile(result.commands[1]!.log, 'utf8')).toBe('ready$(false) | tail')
})

it.each([null, {}, { prerequisites: [], check: [], logDirectory: '/tmp' }, { prerequisites: [['pnpm', 3]], check: ['pnpm'], logDirectory: '/tmp' }])('rejects malformed command plans', (input) => {
  expect(parseCheckPlan(input)._tag).toBe('Err')
})

it('reports a killed command as a signal rather than success', async () => {
  const root = await fixture()
  const result = await runCheckPlan({ prerequisites: [], check: [process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")'], logDirectory: root }, root)
  expect(result.outcome).toEqual({ _tag: 'Signaled', signal: 'SIGTERM' })
})

it('installs an executable command that preserves the child exit', async () => {
  const root = await fixture()
  const sync = spawnSync('bash', [resolve('scripts/sync-agent-context.sh'), 'local'], { env: { ...process.env, HARLAN_AGENT_CONTEXT_HOME: root }, encoding: 'utf8' })
  expect(sync.status, sync.stderr).toBe(0)
  const plan = join(root, 'plan.json')
  await writeFile(plan, JSON.stringify({ prerequisites: [], check: [process.execPath, '-e', 'process.stdout.write("failure evidence"); process.exitCode = 7'], logDirectory: join(root, 'logs') }))
  for (const command of ['.local/bin/agent-check.ts', '.local/share/harlan-agent-kit/github-bin/agent-check.ts']) {
    const result = spawnSync(join(root, command), [plan], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(7)
    const report = JSON.parse(result.stdout)
    expect(await readFile(report.commands[0].log, 'utf8')).toBe('failure evidence')
  }
})

it('installs Check for host and worker use and rejects failing checks', async () => {
  const root = await fixture()
  const sync = spawnSync('bash', [resolve('scripts/sync-agent-context.sh'), 'local'], { env: { ...process.env, HARLAN_AGENT_CONTEXT_HOME: root }, encoding: 'utf8' })
  expect(sync.status, sync.stderr).toBe(0)
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node --experimental-strip-types fixture.ts' } }))
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'verifyDepsBeforeRun: false\n')
  await writeFile(join(root, 'fixture.ts'), 'console.log("Check fixture ran"); process.exitCode = Number(process.env.CHECK_FIXTURE_EXIT ?? 0)\n')
  for (const command of ['.local/bin/check', '.local/share/harlan-agent-kit/github-bin/check']) {
    for (const exit of [0, 7]) {
      const result = spawnSync(join(root, command), [], { cwd: root, env: { ...process.env, CHECK_SKIP: '', CHECK_FIXTURE_EXIT: String(exit), CI: 'true' }, encoding: 'utf8' })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(exit === 0 ? 0 : 1)
      expect(result.stdout).toContain(exit === 0 ? 'All checks passed' : 'Check fixture ran')
    }
  }
})
