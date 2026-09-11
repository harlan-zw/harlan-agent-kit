import { describe, expect, it } from 'vitest'
import { plan, stepArgv } from './plan.ts'

function steps(argv: string[]) {
  const result = plan(argv)
  if (result._tag === 'Err')
    throw new Error(result.message)
  return result.steps
}

describe('hw plan', () => {
  it('sends the agent journal to the agent account and system units to admin', () => {
    expect(steps(['logs', 'agent'])).toEqual([
      { host: 'agent', command: 'journalctl --user -u harlan-github-agent -n 200 --no-pager' },
    ])
    expect(steps(['logs', 'runner', '-n', '50'])).toEqual([
      { host: 'admin', command: 'sudo journalctl -u hogwild-github-runner -n 50 --no-pager' },
    ])
  })

  it('refuses an unknown unit and a non numeric line count', () => {
    expect(plan(['logs', 'sudo'])).toMatchObject({ _tag: 'Err' })
    expect(plan(['logs', 'caddy', '-n', 'many'])).toMatchObject({ _tag: 'Err' })
  })

  it('installs as admin and links as the agent, never the other way', () => {
    const result = steps(['install', 'fd-find', '--link', 'fd=fdfind'])
    expect(result.map(step => step.host)).toEqual(['admin', 'agent', 'local'])
    expect(result[0]?.command).toBe('sudo apt-get install -y fd-find')
    expect(result[1]?.command).toContain('ln -sf "$(command -v fdfind)" ~/.local/bin/fd')
  })

  it('rejects package and link names that could carry shell text', () => {
    expect(plan(['install', 'fd; rm -rf /'])).toMatchObject({ _tag: 'Err' })
    expect(plan(['install', 'fd-find', '--link', 'fd=$(id)'])).toMatchObject({ _tag: 'Err' })
  })

  it('validates before a caddy reload', () => {
    const [step] = steps(['caddy', 'reload'])
    expect(step?.host).toBe('admin')
    expect(step?.command.indexOf('caddy validate')).toBeLessThan(step?.command.indexOf('reload caddy') ?? -1)
  })

  it('never runs a sudo command on the agent account', () => {
    const every = ['status', 'runners', 'pending', 'caddy check', 'logs jellyfin', 'install unzip']
      .flatMap(argv => steps(argv.split(' ')))
    for (const step of every.filter(step => step.host === 'agent'))
      expect(step.command).not.toContain('sudo')
  })

  it('refuses sudo in run agent and keeps it for run admin', () => {
    expect(plan(['run', 'agent', 'sudo', 'ls'])).toMatchObject({ _tag: 'Err' })
    expect(plan(['run', 'agent', 'ls', '&&', 'sudo', 'ls'])).toMatchObject({ _tag: 'Err' })
    expect(steps(['run', 'admin', 'sudo', 'ls'])).toEqual([{ host: 'admin', command: 'sudo ls' }])
    expect(steps(['run', 'agent', 'echo', 'pseudo'])).toEqual([{ host: 'agent', command: 'echo pseudo' }])
  })

  it('passes the remote command to ssh as one unquoted argument', () => {
    const argv = stepArgv({ host: 'admin', command: 'echo "here" | cat' })
    expect(argv).toEqual(['ssh', '-o', 'BatchMode=yes', 'hogwild-admin', 'echo "here" | cat'])
  })
})
