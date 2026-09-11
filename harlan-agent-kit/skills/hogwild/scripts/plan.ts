// Pure planner for the `hw` CLI. It turns argv into the commands to run and
// where to run them. No I/O here; `hw.ts` executes the plan.

export type Host = 'agent' | 'admin' | 'local'

export interface Step {
  host: Host
  /** Shell text. On `agent` and `admin` it runs through `ssh`. */
  command: string
  /** Printed before the step. */
  title?: string
}

export type Plan
  = | { _tag: 'Ok', steps: Step[] }
    | { _tag: 'Err', message: string }

export const SSH_HOST: Record<Exclude<Host, 'local'>, string> = {
  agent: 'hogwild',
  admin: 'hogwild-admin',
}

export const RUNNER_REPO_CONF = '~/pkg/hogwild-gh-runner/github-runner/hogwild-runners.conf'
export const HOST_README = '~/pkg/hogwild-gh-runner/hogwild/README.md'
const LIVE_RUNNER_CONF = '/var/lib/github-runner/config/runners.conf'

/** System units the admin account reads with `sudo journalctl`. */
const SYSTEM_UNITS = [
  'hogwild-github-runner',
  'caddy',
  'cloudflared',
  'adguardhome',
  'jellyfin',
  'docker',
  'hogwild-status',
  'chasing-the-ai-dragon',
  'hogwild-docker-user',
  'tailscaled',
  'ssh',
] as const

const UNIT_ALIASES: Record<string, string> = {
  agent: 'harlan-github-agent',
  runner: 'hogwild-github-runner',
  runners: 'hogwild-github-runner',
  status: 'hogwild-status',
  dragon: 'chasing-the-ai-dragon',
  adguard: 'adguardhome',
  tunnel: 'cloudflared',
}

export const USAGE = `hw <command>

  status                    Host, services, containers, Agent unit, on one screen.
  logs <unit> [-n LINES]    Journal for one unit. Units: agent, runner, caddy, tunnel,
                            adguard, jellyfin, docker, status, dragon, tailscaled, ssh.
  install <apt-package> [--link NAME=SOURCE]
                            apt as admin, then link SOURCE into the Agent's ~/.local/bin.
  caddy check|reload        Validate the Caddyfile, or validate then reload.
  runners                   Live runners.conf against the repo copy, plus job containers.
  pending                   Open host items from hogwild/README.md.
  run agent|admin <shell>   Run one shell command on that account.
  ssh agent|admin           Print the ssh host name.
`

const APT_PACKAGE = /^[a-z0-9][a-z0-9+.-]*$/
const LINK_NAME = /^[a-z0-9][\w.-]*$/i
const SUDO_WORD = /(?:^|[\s;&|(`$])sudo(?:\s|$)/

function flag(argv: string[], name: string): { value: string | undefined, rest: string[] } {
  const index = argv.indexOf(name)
  if (index === -1)
    return { value: undefined, rest: argv }
  const value = argv[index + 1]
  return { value, rest: [...argv.slice(0, index), ...argv.slice(index + 2)] }
}

export function plan(argv: string[]): Plan {
  const [command, ...rest] = argv
  switch (command) {
    case 'status':
      return {
        _tag: 'Ok',
        steps: [
          {
            host: 'admin',
            title: 'host',
            command: [
              'uptime',
              'df -h / | tail -n +2',
              'free -h | sed -n 2p',
              `systemctl is-active ${SYSTEM_UNITS.join(' ')} | paste -d" " - - - - - - - - - - -`,
              'docker ps --format "{{.Names}}  {{.Status}}"',
            ].join('; '),
          },
          {
            host: 'agent',
            title: 'agent',
            command: 'systemctl --user is-active harlan-github-agent; systemctl --user show harlan-github-agent -p ActiveEnterTimestamp --value',
          },
        ],
      }
    case 'logs': {
      const { value: linesRaw, rest: positional } = flag(rest, '-n')
      const lines = linesRaw ?? '200'
      if (!/^\d+$/.test(lines))
        return { _tag: 'Err', message: `Lines must be a number, got ${lines}.` }
      const requested = positional[0]
      if (!requested)
        return { _tag: 'Err', message: 'Name a unit. See hw --help.' }
      const unit = UNIT_ALIASES[requested] ?? requested
      if (unit === 'harlan-github-agent')
        return { _tag: 'Ok', steps: [{ host: 'agent', command: `journalctl --user -u harlan-github-agent -n ${lines} --no-pager` }] }
      if (!(SYSTEM_UNITS as readonly string[]).includes(unit))
        return { _tag: 'Err', message: `Unknown unit ${requested}. See hw --help.` }
      return { _tag: 'Ok', steps: [{ host: 'admin', command: `sudo journalctl -u ${unit} -n ${lines} --no-pager` }] }
    }
    case 'install': {
      const { value: link, rest: positional } = flag(rest, '--link')
      const pkg = positional[0]
      if (!pkg || !APT_PACKAGE.test(pkg))
        return { _tag: 'Err', message: 'Name one apt package, lowercase letters, digits, "+", ".", "-".' }
      const steps: Step[] = [
        { host: 'admin', title: `apt install ${pkg}`, command: `sudo apt-get install -y ${pkg}` },
      ]
      if (link !== undefined) {
        const [name, source] = link.split('=')
        if (!name || !source || !LINK_NAME.test(name) || !LINK_NAME.test(source))
          return { _tag: 'Err', message: '--link takes NAME=SOURCE, for example --link fd=fdfind.' }
        steps.push({
          host: 'agent',
          title: `link ${name} -> ${source}`,
          command: `mkdir -p ~/.local/bin && ln -sf "$(command -v ${source})" ~/.local/bin/${name} && ~/.local/bin/${name} --version`,
        })
      }
      steps.push({ host: 'local', title: 'next', command: `echo "Record ${pkg} in ${HOST_README}."` })
      return { _tag: 'Ok', steps }
    }
    case 'caddy': {
      const action = rest[0]
      const validate = 'sudo caddy validate --config /etc/caddy/Caddyfile'
      if (action === 'check')
        return { _tag: 'Ok', steps: [{ host: 'admin', command: validate }] }
      if (action === 'reload')
        return { _tag: 'Ok', steps: [{ host: 'admin', command: `${validate} && sudo systemctl reload caddy && systemctl is-active caddy` }] }
      return { _tag: 'Err', message: 'caddy takes check or reload.' }
    }
    case 'runners':
      return {
        _tag: 'Ok',
        steps: [
          {
            host: 'local',
            title: 'runners.conf: live against repo (empty means equal)',
            command: [
              `live=$(ssh ${SSH_HOST.admin} sudo cat ${LIVE_RUNNER_CONF}) || exit 1`,
              `repo=$(ssh ${SSH_HOST.agent} cat ${RUNNER_REPO_CONF}) || exit 1`,
              `diff <(printf '%s' "$live") <(printf '%s' "$repo")`,
            ].join('\n'),
          },
          {
            host: 'admin',
            title: 'job containers',
            command: 'systemctl is-active hogwild-github-runner; docker ps --format "{{.Names}}  {{.Status}}"',
          },
        ],
      }
    case 'pending':
      return {
        _tag: 'Ok',
        steps: [{ host: 'agent', command: `awk '/^## Pending/{f=1;next} f && /^## /{f=0} f' ${HOST_README}` }],
      }
    case 'run': {
      const [host, ...shell] = rest
      if (host !== 'agent' && host !== 'admin')
        return { _tag: 'Err', message: 'run takes agent or admin, then the command.' }
      if (shell.length === 0)
        return { _tag: 'Err', message: 'Give run a command.' }
      const command = shell.join(' ')
      if (host === 'agent' && SUDO_WORD.test(command))
        return { _tag: 'Err', message: 'sudo does not run on the Agent account. Use hw run admin.' }
      return { _tag: 'Ok', steps: [{ host, command }] }
    }
    case 'ssh': {
      const host = rest[0]
      if (host !== 'agent' && host !== 'admin')
        return { _tag: 'Err', message: 'ssh takes agent or admin.' }
      return { _tag: 'Ok', steps: [{ host: 'local', command: `echo ${SSH_HOST[host]}` }] }
    }
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      return { _tag: 'Ok', steps: [{ host: 'local', command: `cat <<'HW_USAGE'\n${USAGE}HW_USAGE` }] }
    default:
      return { _tag: 'Err', message: `Unknown command ${command}. See hw --help.` }
  }
}

/**
 * The argv `hw.ts` spawns for one step. ssh joins its trailing arguments with
 * spaces and the remote login shell parses the result, so the command travels
 * as one argument with no extra quoting.
 */
export function stepArgv(step: Step): string[] {
  if (step.host === 'local')
    return ['bash', '-o', 'pipefail', '-c', step.command]
  return ['ssh', '-o', 'BatchMode=yes', SSH_HOST[step.host], step.command]
}
