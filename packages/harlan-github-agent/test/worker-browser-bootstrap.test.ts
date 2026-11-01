import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { prepareAgentSandbox } from '../src/agent-sandbox.ts'

const execute = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'browser-bootstrap-'))
  roots.push(root)
  const home = join(root, 'controller')
  const worker = join(root, 'worker')
  const primary = join(root, 'primary')
  const tools = join(home, '.local/bin')
  const browser = join(home, 'browser')
  const npm = join(home, 'npm')
  const runtimeRoot = join(home, '.local/share/harlan-agent-kit/tools')
  const profilePath = join(root, 'worker.json')
  await Promise.all([mkdir(worker), mkdir(primary), mkdir(tools, { recursive: true }), mkdir(join(browser, 'bin'), { recursive: true }), mkdir(join(npm, 'bin'), { recursive: true }), mkdir(join(runtimeRoot, 'bin'), { recursive: true })])
  await copyFile(process.execPath, join(runtimeRoot, 'bin/browser-node'))
  await chmod(join(runtimeRoot, 'bin/browser-node'), 0o755)
  await writeFile(join(runtimeRoot, 'browser-node.json'), JSON.stringify({ tag: process.version, digest: `sha256:${'a'.repeat(64)}` }), { mode: 0o600 })
  await Promise.all([
    writeFile(join(browser, 'package.json'), JSON.stringify({ name: 'dev-browser', version: '0.2.9', bin: { 'dev-browser': './bin/cli.js' } })),
    writeFile(join(browser, 'bin/cli.js'), `const fs=require('node:fs'); const cp=require('node:child_process'); const path=require('node:path'); const args=process.argv.slice(2); const base=path.join(process.env.HOME,'.dev-browser'); if(args.includes('--help')){console.log('fixture help');} else if(args[0]==='install'||args[0]==='--headless'&&args[1]==='install'){if(fs.existsSync(path.join(process.env.HOME,'fail-browser-setup')))process.exit(23);fs.mkdirSync(base,{recursive:true}); fs.writeFileSync(path.join(base,'daemon.mjs'),'trusted fixture daemon');fs.writeFileSync(path.join(base,'package.json'),JSON.stringify({name:'dev-browser-runtime',dependencies:{'playwright-core':'1.58.2'}})); for(const argv of [['install'],['exec','--','playwright','install','chromium']]) cp.execFileSync('npm',argv,{cwd:base,stdio:'inherit'});} else {const executable=path.join(process.env.HOME,'.cache/ms-playwright/chromium-fixture/chrome');if(!fs.existsSync(executable)){console.error('Browser state missing.');process.exitCode=42;}else {require(path.join(base,'node_modules/playwright-core/lib/server/registry/index.js'));console.log(JSON.stringify({runtime:process.execPath,args,ready:true,token:Boolean(process.env.NUXTSEO_TOKEN)}));}}`),
    writeFile(join(tools, 'dev-browser'), `#!/bin/sh\n# cmd-shim-target=${browser}/bin/cli.js\nexec node '${browser}/bin/cli.js' "$@"\n`, { mode: 0o755 }),
    writeFile(join(npm, 'package.json'), JSON.stringify({ name: 'npm', version: '12.0.2', bin: { npm: './bin/cli.js' } })),
    writeFile(join(npm, 'bin/cli.js'), `const fs=require('node:fs');const cp=require('node:child_process');const path=require('node:path');const base=process.cwd();if(process.argv[2]==='install'){fs.writeFileSync(path.join(process.env.HOME,'setup-secrets'),JSON.stringify({token:Boolean(process.env.NUXTSEO_TOKEN),userConfig:Boolean(process.env.NPM_CONFIG_USERCONFIG)}));const core=path.join(base,'node_modules/playwright-core');fs.mkdirSync(path.join(core,'lib/server/registry'),{recursive:true});fs.writeFileSync(path.join(core,'package.json'),JSON.stringify({name:'playwright-core',version:'1.58.2',main:'lib/server/registry/index.js'}));const paths=Object.fromEntries(['chromium','chromium-headless-shell','ffmpeg'].map(name=>[name,path.join(process.env.HOME,'.cache/ms-playwright',name+'-fixture','chrome')]));fs.writeFileSync(path.join(core,'lib/server/registry/index.js'),'exports.registry={findExecutable:name=>({executablePath:()=>('+JSON.stringify(paths)+')[name]})}');fs.mkdirSync(path.join(base,'node_modules/playwright'),{recursive:true});fs.writeFileSync(path.join(base,'node_modules/playwright/package.json'),JSON.stringify({name:'playwright',version:'1.58.2'}));fs.writeFileSync(path.join(base,'node_modules/playwright/cli.js'),"const fs=require('node:fs');const path=require('node:path');for(const name of ['chromium','chromium-headless-shell','ffmpeg']){const p=path.join(process.env.HOME,'.cache/ms-playwright',name+'-fixture','chrome');fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'fixture',{mode:0o755});}fs.appendFileSync(path.join(process.env.HOME,'setup-runtimes'),process.execPath+'\\\\n');");fs.appendFileSync(path.join(process.env.HOME,'npm-runtimes'),process.execPath+'\\n');}else cp.execFileSync('node',[path.join(base,'node_modules/playwright/cli.js')],{stdio:'inherit'});`),
    writeFile(join(tools, 'npm'), `#!/bin/sh\n# cmd-shim-target=${npm}/bin/cli.js\nexec node '${npm}/bin/cli.js' "$@"\n`, { mode: 0o755 }),
  ])
  await execute('git', ['init', primary])
  await execute('git', ['-C', primary, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '--allow-empty', '-m', 'test: seed fixture'])
  const wtConfig = join(root, 'wt.toml')
  await writeFile(wtConfig, '[list]\njson-schema = 2\n')
  await execute('wt', ['--config', wtConfig, '-C', primary, 'switch', '--create', 'browser-setup', '--base', 'HEAD', '--yes'])
  const worktrees = JSON.parse((await execute('wt', ['--config', wtConfig, '-C', primary, 'list', '--format=json'])).stdout)
  const workspace = worktrees.items.find((item: { branch: string }) => item.branch === 'browser-setup').worktree.path as string
  await writeFile(profilePath, JSON.stringify({ home: worker, codex: '/usr/bin/true', opencode: '/usr/bin/true', tools: [tools], readOnlyPaths: [] }))
  return { home, worker, workspace, profilePath, runtimeRoot }
}

it('lazily seeds fresh browser state with Node24 and reuses it with the ordinary runtime', async () => {
  const f = await fixture()
  const sandbox = await prepareAgentSandbox({ workspace: f.workspace, environment: { HOME: f.home }, provider: 'codex', profilePath: f.profilePath })
  try {
    const original = JSON.parse(sandbox.environment.HARLAN_AGENT_SANDBOX_ENVIRONMENT!)
    const environment = { ...sandbox.environment, HARLAN_AGENT_SANDBOX_ENVIRONMENT: JSON.stringify({ ...original, NUXTSEO_TOKEN: 'fixture-secret', NPM_CONFIG_USERCONFIG: '/home/agent/private-npmrc' }) }
    const run = (args: string[]) => execute(sandbox.binary, [...sandbox.args, '/run/agent/host-tools/dev-browser', ...args], { env: environment, timeout: 10_000 })
    await run(['--help'])
    await expect(readFile(join(f.worker, 'npm-runtimes'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const [result, concurrent] = await Promise.all([run(['--headless', '--browser', 'bootstrap-fixture']), run(['--headless', '--browser', 'second-fixture'])])
    expect(JSON.parse(result.stdout)).toEqual({ runtime: '/run/agent/node', args: ['--headless', '--browser', 'bootstrap-fixture'], ready: true, token: true })
    expect(JSON.parse(concurrent.stdout).ready).toBe(true)
    expect((await readFile(join(f.worker, 'npm-runtimes'), 'utf8')).trim()).toBe('/run/agent/browser-node')
    expect((await readFile(join(f.worker, 'setup-runtimes'), 'utf8')).trim()).toBe('/run/agent/browser-setup/node')
    expect(JSON.parse(await readFile(join(f.worker, 'setup-secrets'), 'utf8'))).toEqual({ token: false, userConfig: false })
    await run(['--headless', 'install'])
    const namedInstall = await run(['--browser', 'install', '--headless'])
    expect(JSON.parse(namedInstall.stdout).args).toEqual(['--browser', 'install', '--headless'])
    expect((await readFile(join(f.worker, 'npm-runtimes'), 'utf8')).trim()).toBe('/run/agent/browser-node')
    await rm(join(f.worker, '.cache/ms-playwright/chromium-fixture/chrome'))
    await run(['--headless'])
    expect((await readFile(join(f.worker, 'npm-runtimes'), 'utf8')).trim().split('\n')).toEqual(['/run/agent/browser-node', '/run/agent/browser-node'])
    await rm(join(f.worker, '.dev-browser/node_modules/playwright-core'), { recursive: true })
    await run(['--headless'])
    expect((await readFile(join(f.worker, 'npm-runtimes'), 'utf8')).trim().split('\n')).toEqual(['/run/agent/browser-node', '/run/agent/browser-node', '/run/agent/browser-node'])
  }
  finally {
    await sandbox.release()
  }
})

it.each(['version', 'alias', 'permissions'] as const)('keeps unrelated commands available when the optional runtime has invalid %s', async (kind) => {
  const f = await fixture()
  if (kind === 'version') {
    await writeFile(join(f.runtimeRoot, 'browser-node.json'), JSON.stringify({ tag: 'v26.8.1', digest: `sha256:${'a'.repeat(64)}` }), { mode: 0o600 })
  }
  else if (kind === 'alias') {
    await rename(join(f.runtimeRoot, 'bin/browser-node'), join(f.runtimeRoot, 'another-node'))
    await symlink(join(f.runtimeRoot, 'another-node'), join(f.runtimeRoot, 'bin/browser-node'))
  }
  else {
    await chmod(join(f.runtimeRoot, 'browser-node.json'), 0o644)
  }
  const sandbox = await prepareAgentSandbox({ workspace: f.workspace, environment: { HOME: f.home }, provider: 'codex', profilePath: f.profilePath })
  try {
    const ordinary = await execute(sandbox.binary, [...sandbox.args, '/usr/bin/printf', 'ordinary'], { env: sandbox.environment, timeout: 10_000 })
    expect(ordinary.stdout).toBe('ordinary')
    const help = await execute(sandbox.binary, [...sandbox.args, '/run/agent/host-tools/dev-browser', '--help'], { env: sandbox.environment, timeout: 10_000 })
    expect(help.stdout.trim()).toBe('fixture help')
    await expect(execute(sandbox.binary, [...sandbox.args, '/run/agent/host-tools/dev-browser', '--headless'], { env: sandbox.environment, timeout: 10_000 })).rejects.toMatchObject({ stderr: expect.stringContaining('managed Node 24 runtime') })
    await expect(readFile(join(f.worker, 'npm-runtimes'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  finally {
    await sandbox.release()
  }
})

it('does not record completion after a failed installer and retries on later browser use', async () => {
  const f = await fixture()
  await writeFile(join(f.worker, 'fail-browser-setup'), 'fail once')
  const sandbox = await prepareAgentSandbox({ workspace: f.workspace, environment: { HOME: f.home }, provider: 'codex', profilePath: f.profilePath })
  try {
    const run = () => execute(sandbox.binary, [...sandbox.args, '/run/agent/host-tools/dev-browser', '--headless'], { env: sandbox.environment, timeout: 10_000 })
    await expect(run()).rejects.toMatchObject({ code: 23 })
    await expect(readFile(join(f.worker, '.local/state/harlan-agent-kit/browser-bootstrap.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(join(f.worker, 'fail-browser-setup'))
    expect(JSON.parse((await run()).stdout).ready).toBe(true)
  }
  finally {
    await sandbox.release()
  }
})

it('omits bootstrap and runtime mounts from Review homes and attached clients', async () => {
  const f = await fixture()
  const reviewHome = join(f.worker, 'review')
  await mkdir(reviewHome)
  for (const context of [{ provider: 'codex', reviewHome }, { provider: 'opencode', networkMode: 'opencode-client' }] as const) {
    const sandbox = await prepareAgentSandbox({ workspace: f.workspace, environment: { HOME: f.home }, profilePath: f.profilePath, ...context })
    try {
      const result = await execute(sandbox.binary, [...sandbox.args, '/run/agent/node', '-e', 'const {existsSync}=require(\'node:fs\');console.log(JSON.stringify({bootstrap:existsSync(\'/run/agent/browser-bootstrap.ts\'),runtime:existsSync(\'/run/agent/browser-node\')}))', '--', '--server', 'http://fixture'], { env: sandbox.environment, timeout: 10_000 })
      expect(JSON.parse(result.stdout)).toEqual({ bootstrap: false, runtime: false })
    }
    finally {
      await sandbox.release()
    }
  }
})

it('rejects a private cache alias before running the installer', async () => {
  const f = await fixture()
  await mkdir(join(f.worker, 'private'))
  await symlink(join(f.worker, 'private'), join(f.worker, '.cache'))
  const sandbox = await prepareAgentSandbox({ workspace: f.workspace, environment: { HOME: f.home }, provider: 'codex', profilePath: f.profilePath })
  try {
    await expect(execute(sandbox.binary, [...sandbox.args, '/run/agent/host-tools/dev-browser', '--headless'], { env: sandbox.environment, timeout: 10_000 })).rejects.toMatchObject({ stderr: expect.stringContaining('must not use file aliases') })
    await expect(readFile(join(f.worker, 'npm-runtimes'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  finally {
    await sandbox.release()
  }
})
