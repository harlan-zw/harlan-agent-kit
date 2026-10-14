import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { planAgentCli } from './agent-cli-plan.ts'

const options = {
  home: '/home/test',
  hostname: 'desktop',
  executable: '/home/test/.local/bin/wolfstar-github-agent',
  runtime: '/service/node',
  checkout: '/service',
  cwd: '/caller',
  args: ['control', 'status'],
}

describe('installed Agent commands', () => {
  it('uses the service runtime and configuration from an unrelated directory', () => {
    expect(planAgentCli(options)).toEqual({
      file: '/service/node',
      args: [
        '--experimental-strip-types',
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        '/service/packages/wolfstar-github-agent/src/cli.ts',
        'control',
        'status',
        '--config',
        '/home/test/.config/wolfstar-github-agent/config.yml',
      ],
      cwd: '/service',
    })
  })
  it('uses loopback on Hogwild and preserves explicit connection options', () => {
    expect(planAgentCli({ ...options, hostname: 'hogwild' }).args).toContain('http://127.0.0.1:3210')
    const explicit = ['--config=/other.yml', 'control', 'status', '--url', 'https://other.test']
    expect(planAgentCli({ ...options, hostname: 'hogwild', args: explicit }).args.slice(3)).toEqual(explicit)
  })
  it('does not start a controller when invoked without arguments', () => {
    expect(planAgentCli({ ...options, args: [] }).args.slice(3)).toEqual(['--help'])
  })
  it('runs the installed Hogwild planner without an interactive alias', () => {
    expect(planAgentCli({ ...options, executable: '/home/test/.local/bin/hw', args: ['runners'] })).toEqual({
      file: '/service/node',
      args: [
        '--experimental-strip-types',
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        '/home/test/.local/share/wolfstar-agent-kit/hogwild/scripts/hw.ts',
        'runners',
      ],
    })
  })
})

it('installs executable commands that work in a noninteractive shell', async () => {
  const execute = promisify(execFile)
  const home = await mkdtemp(join(tmpdir(), 'agent-cli-install-'))
  const checkout = join(home, 'service')
  try {
    await mkdir(join(checkout, 'packages/wolfstar-github-agent/src'), { recursive: true })
    await writeFile(
      join(checkout, 'packages/wolfstar-github-agent/src/cli.ts'),
      'console.log(JSON.stringify({args: process.argv.slice(2), cwd: process.cwd()}))',
    )
    const env = {
      ...process.env,
      HOME: home,
      WOLFSTAR_AGENT_CONTEXT_HOME: home,
      WOLFSTAR_AGENT_CONTEXT_SKIP_MEMORY: '1',
      WOLFSTAR_GITHUB_AGENT_CHECKOUT: checkout,
    }
    await execute('bash', ['scripts/sync-agent-context.sh', 'local'], { env })
    const run = await execute('bash', ['-c', `${home}/.local/bin/wolfstar-github-agent control status`], {
      env,
      cwd: tmpdir(),
    })
    expect(JSON.parse(run.stdout)).toEqual({
      args: [
        'control',
        'status',
        '--config',
        join(home, '.config/wolfstar-github-agent/config.yml'),
        '--url',
        'https://hogwild.tailcad325.ts.net',
      ],
      cwd: checkout,
    })
    const help = await execute('bash', ['-c', `${home}/.local/bin/hw --help`], { env, cwd: tmpdir() })
    expect(help.stdout).toContain('hw <command>')
  } finally {
    await rm(home, { recursive: true })
  }
})

it('uses the configured desktop Control API URL without replacing explicit connection options', () => {
  expect(planAgentCli({ ...options, url: 'https://hogwild.test' }).args.slice(-2)).toEqual([
    '--url',
    'https://hogwild.test',
  ])
  expect(
    planAgentCli({ ...options, url: 'https://hogwild.test', args: ['control', 'status', '--config', '/other.yml'] })
      .args,
  ).not.toContain('https://hogwild.test')
})

it('keeps relative connection files rooted in the caller directory', () => {
  const plan = planAgentCli({
    ...options,
    args: ['control', 'status', '-c', './config.yml', '--password-file=./password'],
  })
  expect(plan.args.slice(3)).toEqual([
    'control',
    'status',
    '-c',
    '/caller/config.yml',
    '--password-file=/caller/password',
  ])
})
