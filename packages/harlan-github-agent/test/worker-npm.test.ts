import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { prepareAgentSandbox } from '../src/agent-sandbox.ts'

const execute = promisify(execFile)

it('lets an isolated browser installer run npm with its bundled dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-npm-'))
  const home = join(root, 'controller')
  const worker = join(root, 'worker')
  const primary = join(root, 'primary')
  const tools = join(home, '.local/bin')
  const browser = join(home, '.local/store/v11/browser/node_modules/dev-browser')
  const npm = join(home, '.local/store/v11/npm/node_modules/npm')
  const alias = join(home, '.local/global/v11/npm/node_modules/npm')
  const secret = join(home, '.config/secret')
  const profilePath = join(root, 'worker.json')
  await Promise.all([mkdir(worker), mkdir(primary), mkdir(tools, { recursive: true }), mkdir(join(browser, 'bin'), { recursive: true }), mkdir(join(npm, 'bin'), { recursive: true }), mkdir(dirname(alias), { recursive: true }), mkdir(dirname(secret), { recursive: true })])
  const dependencies = Object.fromEntries(Array.from({ length: 187 }, (_, index) => [`fixture-${index}`, '1']))
  await Promise.all([
    writeFile(secret, 'Controller secret.'),
    writeFile(join(browser, 'package.json'), JSON.stringify({ name: 'dev-browser', type: 'module', bin: { 'dev-browser': './bin/browser.js' } })),
    writeFile(join(browser, 'bin/browser.js'), `import { execFileSync } from 'node:child_process'; import { fileURLToPath } from 'node:url'; process.stdout.write(execFileSync(fileURLToPath(new URL('./installer', import.meta.url)), process.argv.slice(2), { encoding: 'utf8' }))`),
    writeFile(join(browser, 'bin/installer'), '#!/bin/sh\nmkdir -p "$HOME/.dev-browser-fixture"\ncd "$HOME/.dev-browser-fixture"\nexec npm install\n', { mode: 0o755 }),
    writeFile(join(tools, 'dev-browser'), `#!/bin/sh\n# cmd-shim-target=${browser}/bin/browser.js\nexec node '${browser}/bin/browser.js' "$@"\n`, { mode: 0o755 }),
    writeFile(join(npm, 'package.json'), JSON.stringify({ name: 'npm', version: 'fixture-npm', bin: { npm: './bin/npm-cli.js' }, dependencies, bundleDependencies: Object.keys(dependencies) })),
    writeFile(join(npm, 'bin/npm-cli.js'), `const fs = require('node:fs'); const dependency = require('fixture-186'); fs.writeFileSync('installed', dependency); console.log(JSON.stringify({ version: require('../package.json').version, dependency, runtime: process.execPath, args: process.argv.slice(2), secret: fs.existsSync(${JSON.stringify(secret)}) }))`),
    writeFile(join(tools, 'npm'), `#!/bin/sh\n# cmd-shim-target=${alias}/bin/npm-cli.js\nexec node '${alias}/bin/npm-cli.js' "$@"\n`, { mode: 0o755 }),
    ...Object.keys(dependencies).map(async (name) => {
      const path = join(npm, 'node_modules', name)
      await mkdir(path, { recursive: true })
      await writeFile(join(path, 'package.json'), JSON.stringify({ name, main: './index.js' }))
      await writeFile(join(path, 'index.js'), `module.exports = ${JSON.stringify(name)}`)
    }),
  ])
  await symlink(npm, alias)
  await execute('git', ['init', primary])
  await execute('git', ['-C', primary, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '--allow-empty', '-m', 'test: seed fixture'])
  const wtConfig = join(root, 'wt.toml')
  await writeFile(wtConfig, '[list]\njson-schema = 2\n')
  await execute('wt', ['--config', wtConfig, '-C', primary, 'switch', '--create', 'npm-tool', '--base', 'HEAD', '--yes'])
  const worktrees = JSON.parse((await execute('wt', ['--config', wtConfig, '-C', primary, 'list', '--format=json'])).stdout)
  const workspace = worktrees.items.find((item: { branch: string }) => item.branch === 'npm-tool').worktree.path as string
  await writeFile(profilePath, JSON.stringify({ home: worker, codex: '/usr/bin/true', opencode: '/usr/bin/true', tools: [tools], readOnlyPaths: [] }))
  try {
    const sandbox = await prepareAgentSandbox({ workspace, environment: { HOME: home }, provider: 'codex', profilePath })
    try {
      const result = await execute(sandbox.binary, [...sandbox.args, '/bin/sh', '-c', 'exec dev-browser --headless install'], { env: sandbox.environment, timeout: 10_000 })
      expect(JSON.parse(result.stdout)).toEqual({ version: 'fixture-npm', dependency: 'fixture-186', runtime: '/run/agent/node', args: ['install'], secret: false })
      expect(await readFile(join(worker, '.dev-browser-fixture/installed'), 'utf8')).toBe('fixture-186')
      expect(await readFile(secret, 'utf8')).toBe('Controller secret.')
    }
    finally {
      await sandbox.release()
    }
    const reviewHome = join(root, 'review')
    await mkdir(reviewHome)
    for (const context of [{ provider: 'codex', reviewHome }, { provider: 'opencode', networkMode: 'opencode-client' }] as const) {
      const sandbox = await prepareAgentSandbox({ workspace, environment: { HOME: home }, profilePath, ...context })
      try {
        const result = await execute(sandbox.binary, [...sandbox.args, '/run/agent/node', '-e', `const { existsSync } = require('node:fs'); console.log(JSON.stringify({ package: existsSync(${JSON.stringify(npm)}), launcher: existsSync('/run/agent/host-tools/npm') }))`, '--', '--server', 'http://fixture'], { env: sandbox.environment, timeout: 10_000 })
        expect(JSON.parse(result.stdout)).toEqual({ package: false, launcher: false })
      }
      finally {
        await sandbox.release()
      }
    }
    const credentials = join(home, '.config/npm')
    await mkdir(credentials)
    await writeFile(join(credentials, 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: './cli.js' } }))
    await writeFile(join(credentials, 'cli.js'), 'console.log("private")')
    await writeFile(join(tools, 'npm'), `#!/bin/sh\n# cmd-shim-target=${credentials}/cli.js\n`, { mode: 0o755 })
    await expect(prepareAgentSandbox({ workspace, environment: { HOME: home }, provider: 'codex', profilePath })).rejects.toThrow('exposes controller credentials')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
