import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOST_README, plan, RUNNER_REPO_CONF, SSH_HOST, stepArgv } from './plan.ts'

function steps(argv: string[]) {
  const result = plan(argv)
  if (result._tag === 'Err')
    throw new Error(result.message)
  return result.steps
}

function pendingOutput(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'hw-pending-'))
  try {
    const file = join(dir, 'README.md')
    writeFileSync(file, `# Host\n\n${body}`)
    const [step] = steps(['pending'])
    const command = step!.command.replace(HOST_README, file)
    // The plan sends this awk to the agent account; the helper runs the same
    // command through the local executor so the test needs no host.
    const argv = stepArgv({ ...step!, host: 'local', command })
    return execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8' })
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

  it('prints every pending item when the Pending section ends the README', () => {
    const output = pendingOutput('## Done\n\n- closed item\n\n## Pending\n\n- item one\n- item two\n')
    expect(output).toContain('item one')
    expect(output).toContain('item two')
  })

  it('prints every pending item and no heading when a section follows Pending', () => {
    const output = pendingOutput('## Pending\n\n- item one\n- item two\n\n## Done\n\n- closed item\n')
    expect(output).toContain('item one')
    expect(output).toContain('item two')
    expect(output).not.toContain('##')
  })

  it('reads the pending list on the agent account over ssh', () => {
    const [step] = steps(['pending'])
    expect(step?.host).toBe('agent')
    expect(stepArgv(step!)).toEqual([
      'ssh',
      '-o',
      'BatchMode=yes',
      SSH_HOST.agent,
      `awk '/^## Pending/{f=1;next} f && /^## /{f=0} f' ${HOST_README}`,
    ])
  })

  it('diffs the live runners conf against the repo copy read on the agent account', () => {
    const [diff] = steps(['runners'])
    expect(diff?.host).toBe('local')
    expect(diff?.command).toContain(`ssh ${SSH_HOST.agent} cat ${RUNNER_REPO_CONF}`)
    expect(diff?.command).toContain('|| exit 1')
    expect(diff?.command).not.toContain('|| true')
  })

  it('runners diff exits 0 with empty output only when the confs are equal', () => {
    expect(runnersDiff('same\n', 'same\n')).toEqual({ status: 0, output: '' })
  })

  it('runners diff prints a difference and exits non-zero', () => {
    const { status, output } = runnersDiff('live\n', 'repo\n')
    expect(status).not.toBe(0)
    expect(output).toContain('live')
    expect(output).toContain('repo')
  })

  it('runners diff exits non-zero when the repo copy cannot be read', () => {
    const { status, output } = runnersDiff('live\n', undefined)
    expect(status).not.toBe(0)
    expect(output).not.toBe('')
  })

  it('runners diff exits non-zero when both conf reads fail', () => {
    const { status } = runnersDiff(false, false)
    expect(status).not.toBe(0)
  })
})

/** Runs the runners diff step with each ssh read swapped for a local read or a failing read. */
function runnersDiff(live: string | false, repo: string | false | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'hw-runners-'))
  try {
    const liveFile = join(dir, 'live.conf')
    if (live !== false && live !== undefined)
      writeFileSync(liveFile, live)
    const repoFile = join(dir, 'repo.conf')
    if (repo !== false && repo !== undefined)
      writeFileSync(repoFile, repo)
    const [step] = steps(['runners'])
    const command = step!.command
      .replaceAll(`ssh ${SSH_HOST.admin} sudo cat /var/lib/github-runner/config/runners.conf`, live === false ? 'false' : `cat ${liveFile}`)
      .replaceAll(`ssh ${SSH_HOST.agent} cat '${RUNNER_REPO_CONF}'`, repo === false ? 'false' : `cat ${repoFile}`)
      .replaceAll(`ssh ${SSH_HOST.agent} cat ${RUNNER_REPO_CONF}`, repo === false ? 'false' : `cat ${repoFile}`)
    const { status, stdout, stderr } = spawnSync('bash', ['-o', 'pipefail', '-c', command], { encoding: 'utf8' })
    return { status: status ?? 1, output: `${stdout}${stderr}` }
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
