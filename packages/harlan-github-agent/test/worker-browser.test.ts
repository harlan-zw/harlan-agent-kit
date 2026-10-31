import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { prepareAgentSandbox } from '../src/agent-sandbox.ts'

const execute = promisify(execFile)

it('starts the current installed browser command with adjacent files and dependencies inside the sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-browser-'))
  const home = join(root, 'controller')
  const worker = join(root, 'worker')
  const primary = join(root, 'primary')
  const tools = join(home, '.local/bin')
  const profile = join(root, 'worker.json')
  const secret = join(home, '.config/secret')
  const neighbour = join(home, '.local/store/unrelated')
  await Promise.all([mkdir(worker), mkdir(primary), mkdir(tools, { recursive: true }), mkdir(dirname(secret), { recursive: true }), mkdir(dirname(neighbour), { recursive: true })])
  await Promise.all([writeFile(secret, 'Controller secret.'), writeFile(neighbour, 'Unrelated package.')])
  const install = async (version: string) => {
    const packageRoot = join(home, `.local/store/v11/links/browser/${version}/node_modules/dev-browser`)
    const alias = join(home, `.local/global/v11/${version}/node_modules/dev-browser`)
    const dependency = join(home, `.local/store/v11/links/dependency/${version}/node_modules/fixture-dependency`)
    await Promise.all([mkdir(join(packageRoot, 'bin'), { recursive: true }), mkdir(dirname(alias), { recursive: true }), mkdir(dependency, { recursive: true })])
    await Promise.all([
      writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dev-browser', version, type: 'module', bin: { 'dev-browser': './bin/dev-browser.js' }, dependencies: { 'fixture-dependency': '1' } })),
      writeFile(join(packageRoot, 'bin/dev-browser.js'), `import { readFileSync, existsSync } from 'node:fs'; import { execFileSync } from 'node:child_process'; import { fileURLToPath } from 'node:url'; import { dependency } from 'fixture-dependency'; const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')); console.log(JSON.stringify({ version: manifest.version, dependency, native: execFileSync(fileURLToPath(new URL('./native-fixture', import.meta.url)), process.argv.slice(2), { encoding: 'utf8' }).trim().split('\\n'), secret: existsSync(${JSON.stringify(secret)}), neighbour: existsSync(${JSON.stringify(neighbour)}) }))`),
      writeFile(join(packageRoot, 'bin/native-fixture'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 }),
      writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'fixture-dependency', type: 'module', exports: './index.js' })),
      writeFile(join(dependency, 'index.js'), 'export const dependency = "fixture-dependency"'),
    ])
    await symlink(packageRoot, alias)
    await symlink(dependency, join(packageRoot, '../fixture-dependency'))
    await writeFile(join(tools, 'dev-browser'), `#!/bin/sh\n# cmd-shim-target=${alias}/bin/dev-browser.js\nexec node '${alias}/bin/dev-browser.js' "$@"\n`, { mode: 0o755 })
    return packageRoot
  }
  await execute('git', ['init', primary])
  await execute('git', ['-C', primary, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '--allow-empty', '-m', 'test: seed fixture'])
  const wtConfig = join(root, 'wt.toml')
  await writeFile(wtConfig, '[list]\njson-schema = 2\n')
  await execute('wt', ['--config', wtConfig, '-C', primary, 'switch', '--create', 'browser-tool', '--base', 'HEAD', '--yes'])
  const worktrees = JSON.parse((await execute('wt', ['--config', wtConfig, '-C', primary, 'list', '--format=json'])).stdout)
  const workspace = worktrees.items.find((item: { branch: string }) => item.branch === 'browser-tool').worktree.path as string
  await writeFile(profile, JSON.stringify({ home: worker, codex: '/usr/bin/true', opencode: '/usr/bin/true', tools: [tools], readOnlyPaths: [] }))
  try {
    let currentPackage = ''
    for (const version of ['fixture-1', 'fixture-2']) {
      currentPackage = await install(version)
      const sandbox = await prepareAgentSandbox({ workspace, environment: { HOME: home }, provider: 'codex', profilePath: profile })
      try {
        const result = await execute(sandbox.binary, [...sandbox.args, '/bin/sh', '-c', 'exec dev-browser --version "space and quote\x27"'], { env: sandbox.environment })
        expect(JSON.parse(result.stdout)).toEqual({ version, dependency: 'fixture-dependency', native: ['--version', 'space and quote\x27'], secret: false, neighbour: false })
      }
      finally {
        await sandbox.release()
      }
    }
    const reviewHome = join(root, 'review')
    await mkdir(reviewHome)
    for (const context of [{ provider: 'codex', reviewHome }, { provider: 'opencode', networkMode: 'opencode-client' }] as const) {
      const sandbox = await prepareAgentSandbox({ workspace, environment: { HOME: home }, profilePath: profile, ...context })
      try {
        const result = await execute(sandbox.binary, [...sandbox.args, '/run/agent/node', '-e', `const { existsSync } = require('node:fs'); console.log(JSON.stringify({ package: existsSync(${JSON.stringify(currentPackage)}), launcher: existsSync('/run/agent/host-tools/dev-browser') }))`, '--', '--server', 'http://fixture'], { env: sandbox.environment, timeout: 10_000 })
        expect(JSON.parse(result.stdout)).toEqual({ package: false, launcher: false })
      }
      finally {
        await sandbox.release()
      }
    }
    const credentials = join(home, '.config/credential-package')
    await mkdir(credentials)
    await writeFile(join(credentials, 'package.json'), JSON.stringify({ name: 'fixture-dependency' }))
    await rm(join(currentPackage, '../fixture-dependency'))
    await symlink(credentials, join(currentPackage, '../fixture-dependency'))
    await expect(prepareAgentSandbox({ workspace, environment: { HOME: home }, provider: 'codex', profilePath: profile })).rejects.toThrow('exposes controller credentials')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
