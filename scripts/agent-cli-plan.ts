import { basename, join, resolve } from 'node:path'

export interface AgentCliOptions {
  home: string
  hostname: string
  executable: string
  runtime: string
  checkout: string
  args: string[]
  cwd: string
  url?: string
}

export function planAgentCli(options: AgentCliOptions): { file: string; args: string[]; cwd?: string } {
  if (basename(options.executable) === 'hw') {
    return {
      file: options.runtime,
      args: [
        '--experimental-strip-types',
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        join(options.home, '.local/share/wolfstar-agent-kit/hogwild/scripts/hw.ts'),
        ...options.args,
      ],
    }
  }
  const args = options.args.length === 0 ? ['--help'] : [...options.args]
  const pathOptions = ['--config', '-c', '--password-file']
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const equals = pathOptions.find((name) => arg.startsWith(`${name}=`))
    if (equals !== undefined) args[index] = `${equals}=${resolve(options.cwd, arg.slice(equals.length + 1))}`
    else if (pathOptions.includes(arg) && args[index + 1] !== undefined && !args[index + 1]!.startsWith('-'))
      args[index + 1] = resolve(options.cwd, args[index + 1]!)
  }
  const hasOption = (names: string[]) =>
    args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)))
  const explicitConfig = hasOption(['--config', '-c'])
  if (!args.includes('--help') && !args.includes('-h')) {
    if (!hasOption(['--config', '-c']))
      args.push('--config', join(options.home, '.config/wolfstar-github-agent/config.yml'))
    if (args.includes('control') && !hasOption(['--url'])) {
      if (options.hostname.split('.')[0] === 'hogwild') args.push('--url', 'http://127.0.0.1:3210')
      else if (options.url !== undefined && !explicitConfig) args.push('--url', options.url)
    }
  }
  return {
    file: options.runtime,
    args: [
      '--experimental-strip-types',
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      join(options.checkout, 'packages/wolfstar-github-agent/src/cli.ts'),
      ...args,
    ],
    cwd: options.checkout,
  }
}
