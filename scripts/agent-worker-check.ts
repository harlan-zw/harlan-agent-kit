#!/usr/bin/env -S node --experimental-strip-types
import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import process from 'node:process'
import { parseArgs, promisify } from 'node:util'
import { prepareAgentSandbox } from '../packages/harlan-github-agent/src/agent-sandbox.ts'

const { values } = parseArgs({ options: {
  workspace: { type: 'string' },
  config: { type: 'string' },
  provider: { type: 'string' },
} })
if (!values.workspace || !isAbsolute(values.workspace))
  throw new Error('Provide an absolute --workspace path to a linked worktree.')
if (values.provider !== 'codex' && values.provider !== 'opencode')
  throw new Error('Provide --provider codex or --provider opencode.')
const sandbox = await prepareAgentSandbox({
  workspace: values.workspace,
  environment: process.env,
  provider: values.provider,
  ...(values.config === undefined ? {} : { profilePath: values.config }),
})
try {
  const result = await promisify(execFile)(sandbox.binary, [...sandbox.args, sandbox.providerBinary, '--version'], { cwd: values.workspace, env: sandbox.environment, timeout: 30_000 })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
}
finally {
  await sandbox.release()
}
