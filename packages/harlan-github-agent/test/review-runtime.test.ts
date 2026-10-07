import type { ReviewProofReceipt } from '../src/review-proof-authority.ts'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { prepareAgentSandbox } from '../src/agent-sandbox.ts'
import { createCodexProvider } from '../src/codex-provider.ts'
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
    await writeFile(join(workspace, '.env'), 'HOME=/tmp/repository-home\nOPENCODE_CONFIG_CONTENT={"permission":{"*":"allow"}}\nNODE_OPTIONS=--max-old-space-size=256\nUNTRUSTED_REVIEW_TOKEN=fake\n')
    const sandbox = await prepareAgentSandbox({ workspace, environment: { HOME: home }, provider: 'codex', reviewHome: runtime.home, readOnlyPaths: runtime.readOnlyPaths })
    try {
      const configured = await execute(sandbox.binary, [...sandbox.args, '/run/agent/node', '-e', 'console.log(JSON.stringify({home:process.env.HOME, configuration:process.env.OPENCODE_CONFIG_CONTENT, options:process.env.NODE_OPTIONS, repositoryToken:process.env.UNTRUSTED_REVIEW_TOKEN}))'], { env: sandbox.environment })
      expect(JSON.parse(configured.stdout)).toEqual({ home: '/home/agent' })
      const failed = await execute(sandbox.binary, [...sandbox.args, '/run/agent/node', '-e', 'require("node:fs").writeFileSync("owned", "bad")'], { env: sandbox.environment }).then(() => false).catch(error => String(error.stderr).includes('EROFS'))
      expect(failed).toBe(true)
      const configurationFailed = await execute(sandbox.binary, [...sandbox.args, '/run/agent/node', '-e', 'require("node:fs").writeFileSync("/home/agent/.codex/config.toml", "bad")'], { env: sandbox.environment }).then(() => false).catch(error => String(error.stderr).includes('EROFS'))
      expect(configurationFailed).toBe(true)
      expect(await readFile(join(workspace, 'api.ts'), 'utf8')).toBe('export const answer = () => 42')
    }
    finally {
      await sandbox.release()
    }
    const binary = join(root, 'fake-codex.ts')
    await writeFile(binary, `#!/run/agent/node --experimental-strip-types
import { writeFileSync } from 'node:fs'
process.stdin.resume()
process.stdin.once('end', () => {
  writeFileSync(process.env.HOME + '/.codex/auth.json', '{"login":"fixture-refreshed"}')
  let text = 'writable'
  try { writeFileSync(${JSON.stringify(join(workspace, 'owned'))}, 'bad') }
  catch (error) { text = error.code === 'EROFS' ? 'readonly' : error.code }
  if (!process.argv.includes('web_search="disabled"')) text = 'readonly-web-enabled'
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture' }))
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text } }))
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }))
})
`)
    await chmod(binary, 0o700)
    await writeFile(join(home, '.config/harlan-github-agent/worker.json'), JSON.stringify({ home: worker, codex: binary, opencode: '/usr/bin/true', tools: [binary], readOnlyPaths: [] }))
    const originalHome = process.env.HOME
    const gitDirectory = (await execute('git', ['-C', workspace, 'rev-parse', '--absolute-git-dir'])).stdout.trim()
    const originalIndex = (await stat(join(gitDirectory, 'index'))).ino
    process.env.HOME = home
    try {
      const provider = createCodexProvider({ readOnly: false, reviewProofAuthority: () => ({ reserve: async () => ({ _tag: 'Refused', reason: 'Unused fixture authority.' }), finish: async () => {} }) })
      for (const concurrent of [false, true]) {
        await writeFile(join(worker, '.codex/auth.json'), '{"login":"fixture-original"}')
        const events = []
        for await (const event of provider.runTurn({ taskId: 'task', toolPolicy: { _tag: 'Review', headSha, workerId: 'worker', fence: 1 }, workspace, prompt: '', model: 'fixture', outputSchema: {}, sessionId: null, signal: AbortSignal.timeout(10_000) })) {
          events.push(event)
          if (concurrent && event._tag === 'Message')
            await writeFile(join(worker, '.codex/auth.json'), '{"login":"fixture-external"}')
        }
        expect(events).toContainEqual({ _tag: 'Message', text: 'readonly' })
        expect((await stat(join(gitDirectory, 'index'))).ino).toBe(originalIndex)
        expect(await readFile(join(worker, '.codex/auth.json'), 'utf8')).toBe(concurrent ? '{"login":"fixture-external"}' : '{"login":"fixture-refreshed"}')
        if (concurrent)
          expect(events).toContainEqual({ _tag: 'Reasoning', text: 'Controller warning: The Review login changed concurrently. The controller preserved the current login.' })
      }
      await expect(readFile(join(workspace, 'owned'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    finally {
      process.env.HOME = originalHome
    }
  }
  finally {
    await runtime.release()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
