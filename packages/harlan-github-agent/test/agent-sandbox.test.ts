import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { checkAgentWorker, prepareAgentSandbox, runAgentSandboxCommand } from '../src/agent-sandbox.ts'
import { createCodexProvider } from '../src/codex-provider.ts'
import { createOpencodeProvider } from '../src/opencode-provider.ts'

const execute = promisify(execFile)

it('blocks controller credentials, Git helpers, and parent process reads while preserving worker tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-boundary-'))
  const home = join(root, 'controller')
  const worker = join(root, 'worker')
  const primary = join(root, 'primary')
  await Promise.all([mkdir(home), mkdir(worker), mkdir(primary)])
  const secret = join(home, 'credential')
  await writeFile(secret, 'fake-controller-secret')
  await writeFile(join(home, '.gitconfig'), `[credential]\n helper = !cat ${secret}\n`)
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(join(home, '.codex/auth.json'), 'fake-provider-login')
  await mkdir(join(home, '.config/opencode'), { recursive: true })
  await writeFile(join(home, '.config/opencode/opencode.json'), JSON.stringify({ provider: { 'zai-coding-plan': { options: { apiKey: 'fake-provider-key' } } }, mcp: { unsafe: { command: ['cat', secret] } } }))
  await execute('git', ['init', primary])
  await execute('git', ['-C', primary, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '--allow-empty', '-m', 'test: seed fixture'])
  await execute('git', ['-C', primary, 'config', 'credential.helper', `!cat ${secret}`])
  const wtConfig = join(root, 'wt.toml')
  await writeFile(wtConfig, '[list]\njson-schema = 2\n')
  await execute('wt', ['--config', wtConfig, '-C', primary, 'switch', '--create', 'sandbox', '--base', 'HEAD', '--yes'])
  const worktrees = JSON.parse((await execute('wt', ['--config', wtConfig, '-C', primary, 'list', '--format=json'])).stdout)
  const workspace = worktrees.items.find((item: { branch: string }) => item.branch === 'sandbox').worktree.path as string
  await writeFile(join(workspace, '.env'), `TOOLING_TOKEN=fake-repository-token\nHOME=${join(root, 'attacker')}\nOPENCODE_CONFIG_CONTENT={"instructions":[${JSON.stringify(secret)}]}\n`)
  const toolDirectory = join(root, 'bin')
  await mkdir(toolDirectory)
  const fakeProvider = join(toolDirectory, 'provider.ts')
  await writeFile(fakeProvider, `#!/run/agent/node --experimental-strip-types
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
if (existsSync(${JSON.stringify(secret)}) || process.env.GH_TOKEN || process.env.CONTROLLER_TOKEN) process.exit(30)
if (process.argv[2] === 'serve') {
  const server = createServer((request, response) => {
    const expected = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64')
    if (request.headers.authorization !== expected) { response.writeHead(401); response.end(); return }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ id: 'ses_fixture', protected: true }))
  })
  server.listen(4097, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:4097'))
} else if (process.argv[2] === 'run') {
  async function run() {
    const target = process.argv[process.argv.indexOf('--attach') + 1]
    const response = await fetch(target + '/fixture', { headers: { authorization: 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64') } })
    if (!response.ok || !(await response.json()).protected) process.exit(31)
    console.log(JSON.stringify({ type: 'text', sessionID: 'ses_fixture', part: { type: 'text', text: '{"protected":true}' } }))
    console.log(JSON.stringify({ type: 'step_finish', sessionID: 'ses_fixture', part: { reason: 'stop' } }))
  }
  run().catch(error => { console.error(error.message); process.exit(32) })
} else {
  const schemaIndex = process.argv.indexOf('--output-schema')
  if (schemaIndex === -1 || !JSON.parse(readFileSync(process.argv[schemaIndex + 1], 'utf8'))) process.exit(33)
  process.stdin.resume()
  process.stdin.once('end', () => {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }))
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: '{"protected":true}' } }))
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }))
  })
}
`)
  await chmod(fakeProvider, 0o755)
  const profile = join(home, '.config/harlan-github-agent/worker.json')
  await execute(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../../../scripts/agent-worker.ts', import.meta.url)), '--source-home', home, '--worker-home', worker, '--config', profile, '--codex', fakeProvider, '--opencode', fakeProvider])
  expect((await stat(worker)).mode & 0o777).toBe(0o700)
  expect(JSON.parse(await readFile(join(worker, '.config/opencode/opencode.json'), 'utf8'))).toEqual({ provider: { 'zai-coding-plan': { options: { apiKey: 'fake-provider-key' } } } })
  await checkAgentWorker({ HOME: home }, profile)
  const unsafeProfile = join(root, 'unsafe-worker.json')
  await writeFile(unsafeProfile, JSON.stringify({ home: worker, codex: fakeProvider, opencode: fakeProvider, tools: [home], readOnlyPaths: [] }))
  await expect(checkAgentWorker({ HOME: home }, unsafeProfile)).rejects.toThrow('exposes controller credentials')
  await expect(checkAgentWorker({ HOME: home }, join(root, 'missing-worker.json'))).rejects.toThrow()
  const sandbox = await prepareAgentSandbox({
    workspace,
    environment: { HOME: home, PATH: '/usr/bin:/bin', GH_TOKEN: 'fake-personal-token', CONTROLLER_TOKEN: 'fake-controller-token', TOOLING_TOKEN: 'fake-repository-token' },
    profilePath: profile,
    provider: 'opencode',
  })
  expect(sandbox.environment).toEqual({ PATH: '/usr/bin:/bin' })
  const host = createServer((_request, response) => response.end('fake-host-session-secret'))
  await new Promise<void>((resolve) => {
    host.listen(0, '127.0.0.1', resolve)
  })
  const hostPort = (host.address() as { port: number }).port
  try {
    const result = await execute(sandbox.binary, [...sandbox.args, '/usr/bin/bash', '-c', `
      test ! -e '${secret}' || exit 10
      test ! -e '/proc/${process.pid}/environ' || exit 11
      test -z "$GH_TOKEN$CONTROLLER_TOKEN" || exit 12
      test "$(cat "$HOME/.codex/auth.json")" = fake-provider-login || exit 13
      test "$TOOLING_TOKEN" = fake-repository-token || exit 14
      printf 'protocol=https\\nhost=github.com\\n\\n' | git -c credential.interactive=never credential fill >/dev/null 2>&1 && exit 15
      curl --noproxy '*' --silent --max-time 1 'http://127.0.0.1:${hostPort}' >/dev/null 2>&1 && exit 18
      curl --noproxy '*' --silent --max-time 1 'http://10.0.0.1' >/dev/null 2>&1 && exit 19
      curl --noproxy '*' --silent --max-time 1 'http://169.254.169.254' >/dev/null 2>&1 && exit 20
      test "$(curl --noproxy '' --silent -x "$HTTP_PROXY" -o /tmp/refused -w '%{http_code}' 'http://127.0.0.1')" = 403 || exit 21
      ${process.env.AGENT_EGRESS_LIVE_SMOKE === '1' ? 'curl --silent --show-error --fail --max-time 15 https://example.com >/dev/null || exit 22' : ''}
      echo change > smoke.txt
      git add smoke.txt || exit 16
      git -c user.name=Agent -c user.email=agent@example.com commit -m 'test: prove isolated Git writes' >/dev/null || exit 17
      echo protected
    `], { env: sandbox.environment, cwd: workspace })
    expect(result.stdout.trim()).toBe('protected')
    expect((await execute('git', ['-C', workspace, 'log', '-1', '--format=%s'])).stdout.trim()).toBe('test: seed fixture')
    await sandbox.release()
    expect(await readFile(secret, 'utf8')).toBe('fake-controller-secret')
    expect((await execute('git', ['-C', workspace, 'log', '-1', '--format=%s'])).stdout.trim()).toBe('test: prove isolated Git writes')
    expect((await execute('git', ['-C', workspace, 'status', '--porcelain'])).stdout).toBe('?? .env\n')
    const request = { model: 'fixture', outputSchema: {}, prompt: 'Return protected.', sessionId: null, signal: new AbortController().signal, workspace }
    const originalHome = process.env.HOME
    process.env.HOME = home
    try {
      for (const provider of [createCodexProvider(), createOpencodeProvider({ environment: { HOME: home, PATH: '/usr/bin:/bin', GH_TOKEN: 'fake-host-token', CONTROLLER_TOKEN: 'fake-host-token' } })]) {
        const events = []
        for await (const event of provider.runTurn(request))
          events.push(event)
        expect(events).toContainEqual({ _tag: 'Message', text: '{"protected":true}' })
        expect(events).toContainEqual({ _tag: 'TurnCompleted' })
        expect(events.filter(event => event._tag === 'Failed')).toEqual([])
      }
    }
    finally {
      process.env.HOME = originalHome
    }
  }
  finally {
    await new Promise<void>((resolve, reject) => host.close(error => error ? reject(error) : resolve()))
    await sandbox.release()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it('refuses a missing worker configuration instead of launching outside isolation', async () => {
  await expect(prepareAgentSandbox({ workspace: '/tmp', environment: {}, profilePath: '/does-not-exist/worker.json', provider: 'opencode' })).rejects.toThrow()
})

it('keeps Git administrative settings immutable while preserving atomic index writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-git-settings-'))
  const primary = join(root, 'primary')
  const controller = join(root, 'controller')
  const worker = join(root, 'worker')
  await Promise.all([mkdir(primary), mkdir(controller), mkdir(worker)])
  let sandbox: Awaited<ReturnType<typeof prepareAgentSandbox>> | undefined
  try {
    await execute('git', ['init', primary])
    await execute('git', ['-C', primary, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '--allow-empty', '-m', 'test: seed fixture'])
    await execute('git', ['-C', primary, 'config', 'extensions.worktreeConfig', 'true'])
    const wtConfig = join(root, 'wt.toml')
    await writeFile(wtConfig, '[list]\njson-schema = 2\n')
    await execute('wt', ['--config', wtConfig, '-C', primary, 'switch', '--create', 'settings', '--base', 'HEAD', '--yes'])
    const worktrees = JSON.parse((await execute('wt', ['--config', wtConfig, '-C', primary, 'list', '--format=json'])).stdout)
    const workspace = worktrees.items.find((item: { branch: string }) => item.branch === 'settings').worktree.path as string
    const taskDirectory = (await execute('git', ['-C', workspace, 'rev-parse', '--absolute-git-dir'])).stdout.trim()
    const common = (await execute('git', ['-C', workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()
    const originalPointer = await readFile(join(workspace, '.git'), 'utf8')
    const originalCommon = await readFile(join(taskDirectory, 'commondir'), 'utf8')
    const profile = join(root, 'worker.json')
    await writeFile(profile, JSON.stringify({ home: worker, tools: ['/usr/bin'], readOnlyPaths: [], codex: '/usr/bin/true', opencode: '/usr/bin/true' }))
    sandbox = await prepareAgentSandbox({ workspace, environment: { HOME: controller }, profilePath: profile, provider: 'codex' })
    await execute(sandbox.binary, [...sandbox.args, '/usr/bin/bash', '-c', `
      if printf '[core]\\n hooksPath = /tmp/untrusted\\n' > '${taskDirectory}/config.worktree'; then exit 10; fi
      if printf '/tmp/untrusted\\n' > '${taskDirectory}/commondir'; then exit 11; fi
      if printf 'gitdir: /tmp/untrusted\\n' > '${workspace}/.git'; then exit 12; fi
      printf 'change\\n' > change.txt
      git add change.txt || exit 13
      git -c user.name=Agent -c user.email=agent@example.com commit -m 'test: preserve atomic Git writes' || exit 14
      if printf 'fixture\\n' > /run/agent/base-objects/info/private-fixture; then exit 15; fi
      printf 'fixture\\n' > '${common}/objects/info/private-fixture'
      mkdir -p '${common}/refs/private'
      printf 'fixture\\n' > '${common}/refs/private/disposable'
    `], { env: sandbox.environment })
    await sandbox.release()
    expect(await readFile(join(workspace, '.git'), 'utf8')).toBe(originalPointer)
    expect(await readFile(join(taskDirectory, 'commondir'), 'utf8')).toBe(originalCommon)
    await expect(readFile(join(taskDirectory, 'config.worktree'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(common, 'objects/info/private-fixture'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(common, 'refs/private/disposable'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await execute('git', ['-C', workspace, 'status', '--porcelain'])).stdout).toBe('')
    expect((await execute('git', ['-C', workspace, 'log', '-1', '--format=%s'])).stdout.trim()).toBe('test: preserve atomic Git writes')
    const evidence = join(root, 'evidence')
    await mkdir(evidence)
    const protectedFile = join(controller, 'private-fixture')
    await writeFile(protectedFile, 'private fixture')
    const probe = join(workspace, 'check.ts')
    await writeFile(probe, `import { existsSync, writeFileSync } from 'node:fs'\nimport process from 'node:process'\nif (existsSync(${JSON.stringify(protectedFile)}) || process.env.GH_TOKEN) process.exit(1)\nif (process.env.CI !== 'true') process.exit(2)\nwriteFileSync(${JSON.stringify(join(evidence, 'result'))}, 'isolated')\n`)
    const result = await runAgentSandboxCommand({ workspace, command: '/run/agent/node', args: ['--experimental-strip-types', probe], signal: AbortSignal.timeout(5_000), environment: { HOME: controller, GH_TOKEN: 'fixture', CI: 'true' }, profilePath: profile, writablePaths: [evidence] })
    expect(result.exitCode).toBe(0)
    expect(await readFile(join(evidence, 'result'), 'utf8')).toBe('isolated')
    const stale = await prepareAgentSandbox({ workspace, environment: { HOME: controller }, profilePath: profile, provider: 'codex' })
    await execute('git', ['-C', workspace, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '--allow-empty', '-m', 'test: preserve newer host head'])
    await expect(stale.release()).rejects.toThrow('cannot lock ref')
    expect((await execute('git', ['-C', workspace, 'log', '-1', '--format=%s'])).stdout.trim()).toBe('test: preserve newer host head')
    await rename(join(common, 'objects'), join(root, 'aliased-objects'))
    await symlink(join(root, 'aliased-objects'), join(common, 'objects'))
    const aliased = prepareAgentSandbox({ workspace, environment: { HOME: controller }, profilePath: profile, provider: 'codex' })
    await expect(aliased).rejects.toThrow('own ordinary directory')
  }
  finally {
    await sandbox?.release()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
