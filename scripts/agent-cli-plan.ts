import { basename, join } from 'node:path'

export interface AgentCliOptions {
  home: string
  hostname: string
  executable: string
  runtime: string
  checkout: string
  args: string[]
  url?: string
}

export function planAgentCli(options: AgentCliOptions): { file: string, args: string[], cwd?: string } {
  if (basename(options.executable) === 'hw') {
    return { file: options.runtime, args: ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(options.home, '.local/share/harlan-agent-kit/hogwild/scripts/hw.ts'), ...options.args] }
  }
  const args = options.args.length === 0 ? ['--help'] : [...options.args]
  const hasOption = (names: string[]) => args.some(arg => names.some(name => arg === name || arg.startsWith(`${name}=`)))
  const explicitConfig = hasOption(['--config', '-c'])
  if (!args.includes('--help') && !args.includes('-h')) {
    if (!hasOption(['--config', '-c']))
      args.push('--config', join(options.home, '.config/harlan-github-agent/config.yml'))
    if (args.includes('control') && !hasOption(['--url'])) {
      if (options.hostname.split('.')[0] === 'hogwild')
        args.push('--url', 'http://127.0.0.1:3210')
      else if (options.url !== undefined && !explicitConfig)
        args.push('--url', options.url)
    }
  }
  return { file: options.runtime, args: ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(options.checkout, 'packages/harlan-github-agent/src/cli.ts'), ...args], cwd: options.checkout }
}
