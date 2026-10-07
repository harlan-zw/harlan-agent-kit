import type { AgentTurnRequest } from './agent-provider.ts'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { prepareAgentSandbox } from './agent-sandbox.ts'

/** Collect immutable evidence before exposing any tools. No Agent input selects Git commands. */
export async function prepareReviewEvidence(input: { root: string, request: AgentTurnRequest, provider: 'codex' | 'opencode', environment: NodeJS.ProcessEnv }): Promise<string> {
  const { request, root } = input
  if (request.toolPolicy?._tag !== 'Review')
    throw new Error('Exact revision evidence requires controller Review ownership.')
  const path = join(root, 'tools/evidence.json')
  const home = join(root, 'evidence-home')
  await mkdir(join(home, '.config/opencode'), { recursive: true, mode: 0o700 })
  await writeFile(join(home, '.config/opencode/opencode.json'), '{}', { mode: 0o600 })
  const source = import.meta.url.endsWith('.ts')
  const entry = join(root, source ? 'review-evidence-cli.ts' : 'review-evidence-cli.mjs')
  await copyFile(fileURLToPath(new URL(source ? './review-evidence-cli.ts' : '../review-evidence-cli.mjs', import.meta.url)), entry)
  const sandbox = await prepareAgentSandbox({ workspace: request.workspace, provider: input.provider, environment: input.environment, reviewHome: home, readOnlyPaths: [entry], readOnly: true })
  let value: string
  try {
    value = await new Promise<string>((resolve, reject) => {
      const child = spawn(sandbox.binary, [...sandbox.args, '/run/agent/node', '--experimental-strip-types', entry, '--review-evidence', request.workspace, request.toolPolicy!.baseSha, request.toolPolicy!.headSha], { detached: true, env: sandbox.environment, stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []
      let bytes = 0
      let failure: string | undefined
      let stderr = ''
      const kill = () => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL')
          }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
              reject(error)
          }
        }
      }
      const timer = setTimeout(() => {
        failure = 'Exact revision evidence exceeded its 60000 millisecond deadline.'
        kill()
      }, 60_000)
      const abort = () => {
        failure = 'Exact revision evidence was cancelled.'
        kill()
      }
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted)
        abort()
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 8_000_000) {
          failure = 'Exact revision evidence exceeds 8000000 bytes.'
          kill()
        }
        else {
          chunks.push(chunk)
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-500)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        request.signal.removeEventListener('abort', abort)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        request.signal.removeEventListener('abort', abort)
        resolve(failure !== undefined || code !== 0 ? JSON.stringify({ _tag: 'Unavailable', reason: failure ?? `Exact revision evidence failed: ${stderr}` }) : Buffer.concat(chunks).toString('utf8'))
      })
    })
  }
  finally { await sandbox.release() }
  await writeFile(path, value, { mode: 0o400, flag: 'wx' })
  return path
}
