import type { ReviewProofReceipt } from '../src/review-proof-authority.ts'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { prepareAgentSandbox } from '../src/agent-sandbox.ts'
import { requestReviewProof } from '../src/review-proof-transport.ts'
import { createReviewRuntime } from '../src/review-runtime.ts'

const execute = promisify(execFile)
it('runs the proof in a readonly namespace and retains the first failure across a second request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-runtime-'))
  const home = join(root, 'controller')
  const worker = join(root, 'worker')
  const primary = join(root, 'primary')
  await Promise.all([mkdir(join(home, '.config/harlan-github-agent'), { recursive: true }), mkdir(join(worker, '.codex'), { recursive: true }), mkdir(primary)])
  await writeFile(join(worker, '.codex/auth.json'), '{"login":"fixture-only"}')
  await writeFile(join(home, 'secret'), 'fake-controller-secret')
  await writeFile(join(home, '.config/harlan-github-agent/worker.json'), JSON.stringify({ home: worker, codex: '/usr/bin/true', opencode: '/usr/bin/true', tools: [], readOnlyPaths: [] }))
  await execute('git', ['init', primary])
  await writeFile(join(primary, 'api.ts'), 'export const answer = () => 42')
  await execute('git', ['-C', primary, 'add', 'api.ts'])
  await execute('git', ['-C', primary, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '-m', 'test: seed fixture'])
  const wtConfig = join(root, 'wt.toml')
  await writeFile(wtConfig, '[list]\njson-schema = 2\n')
  await execute('wt', ['--config', wtConfig, '-C', primary, 'switch', '--create', 'review', '--base', 'HEAD', '--yes'])
  const listing = JSON.parse((await execute('wt', ['--config', wtConfig, '-C', primary, 'list', '--format=json'])).stdout) as { items: { branch: string, worktree: { path: string } }[] }
  const workspace = listing.items.find(item => item.branch === 'review')!.worktree.path
  const loginAlias = join(workspace, 'provider-login')
  await symlink('/home/agent/.codex/auth.json', loginAlias)
  const headSha = (await execute('git', ['-C', workspace, 'rev-parse', 'HEAD'])).stdout.trim()
  let reserved = false
  const receipts: ReviewProofReceipt[] = []
  const runtime = await createReviewRuntime({ environment: { HOME: home }, provider: 'codex', request: { taskId: 'task', toolPolicy: { _tag: 'Review', headSha, workerId: 'worker', fence: 1 }, workspace, prompt: '', model: '', outputSchema: {}, sessionId: null, signal: AbortSignal.timeout(30_000) }, authority: () => ({
    async reserve() {
      if (reserved)
        return { _tag: 'Refused', reason: 'The first proof remains final.', ...(receipts[0] === undefined ? {} : { receipt: receipts[0] }) }
      reserved = true
      return { _tag: 'Reserved', reservationId: 'one' }
    },
    async finish({ receipt }) {
      receipts.push(receipt)
    },
  }) })
  try {
    const socket = runtime.readOnlyPaths[1]!
    const first = await requestReviewProof(socket, { planId: 'node-typescript', source: `
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { connect } from 'node:net'
import * as inspector from 'node:inspector'
import { answer } from ${JSON.stringify(join(workspace, 'api.ts'))}
assert.equal(process.pid, 1)
assert.equal(process.ppid, 0)
assert.throws(() => readFileSync(${JSON.stringify(loginAlias)}))
assert.throws(() => execFileSync('/usr/bin/true'), { code: 'ERR_ACCESS_DENIED' })
assert.throws(() => process.execve('/proc/self/exe', ['node', '-e', 'console.log("replacement")'], {}), { code: 'ERR_ACCESS_DENIED' })
assert.throws(() => new Worker('console.log(1)', { eval: true }), { code: 'ERR_ACCESS_DENIED' })
assert.throws(() => process.dlopen({ exports: {} }, '/tmp/addon.node'), { code: 'ERR_DLOPEN_DISABLED' })
process._debugProcess(process.pid)
process.kill(process.pid, 'SIGUSR1')
assert.throws(() => inspector.open(9229, '127.0.0.1', false), { code: 'ERR_ACCESS_DENIED' })
const inspectorReachable = await new Promise(resolve => {
  const socket = connect(9229, '127.0.0.1')
  socket.once('error', () => resolve(false))
  socket.once('connect', () => { socket.destroy(); resolve(true) })
})
assert.equal(inspectorReachable, false)
console.log('Provider login absent; inspector and alternate processes denied')
assert.equal(answer(), 43)
` })
    expect(JSON.stringify(first)).toContain('Exited')
    expect(JSON.stringify(first)).toContain('AssertionError')
    expect(JSON.stringify(first)).toContain('Provider login absent')
    expect(JSON.stringify(first)).toContain('inspector and alternate processes denied')
    expect(JSON.stringify(first)).not.toContain('fixture-only')
    expect(receipts).toHaveLength(1)
    expect(receipts[0]!.outcome._tag).toBe('Exited')
    if (receipts[0]!.outcome._tag === 'Exited')
      expect(receipts[0]!.outcome.exitCode).not.toBe(0)
    const second = await requestReviewProof(socket, { planId: 'node-typescript', source: 'console.log("weaker test")' })
    expect(JSON.stringify(second)).toContain('Refused')
    expect(JSON.stringify(second)).toContain('AssertionError')
    expect(receipts).toHaveLength(1)
    const sandbox = await prepareAgentSandbox({ workspace, environment: { HOME: home }, provider: 'codex', reviewHome: runtime.home, readOnlyPaths: runtime.readOnlyPaths })
    try {
      const failed = await execute(sandbox.binary, [...sandbox.args, '/run/agent/node', '-e', 'require("node:fs").writeFileSync("owned", "bad")'], { env: sandbox.environment }).then(() => false).catch(error => String(error.stderr).includes('EROFS'))
      expect(failed).toBe(true)
      const configurationFailed = await execute(sandbox.binary, [...sandbox.args, '/run/agent/node', '-e', 'require("node:fs").writeFileSync("/home/agent/.codex/config.toml", "bad")'], { env: sandbox.environment }).then(() => false).catch(error => String(error.stderr).includes('EROFS'))
      expect(configurationFailed).toBe(true)
      expect(await readFile(join(workspace, 'api.ts'), 'utf8')).toBe('export const answer = () => 42')
    }
    finally {
      await sandbox.release()
    }
  }
  finally {
    await runtime.release()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
