import type { AgentTurnRequest } from './agent-provider.ts'
import type { ReviewProofAuthorityFactory } from './review-proof-authority.ts'
import type { ReviewHomeRelease } from './review-provider-home.ts'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReviewProofLauncher } from './review-proof-process.ts'
import { prepareReviewProofSandbox } from './review-proof-sandbox.ts'
import { serveReviewProof } from './review-proof-transport.ts'
import { createReviewProof } from './review-proof.ts'
import { createReviewProviderHome } from './review-provider-home.ts'

export interface ReviewRuntime {
  home: string
  readOnlyPaths: string[]
  opencodeConfiguration: string
  release: () => Promise<ReviewHomeRelease>
}

export const REVIEW_TOOL_NAMES = ['controller_review_review_read', 'controller_review_review_search', 'controller_review_review_proof'] as const
export const REVIEW_CODEX_FEATURES = Object.fromEntries([
  'shell_tool',
  'unified_exec',
  'code_mode',
  'code_mode_host',
  'js_repl',
  'multi_agent_v2',
  'multi_agent',
  'code_mode_only_strict_3p_tools',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_local_automation',
  'plugins',
  'apps',
  'remote_plugin',
  'skill_mcp_dependency_install',
  'hooks',
  'view_image',
].map(name => [name, false]))

export async function createReviewRuntime(input: { request: AgentTurnRequest, provider: 'codex' | 'opencode', environment: NodeJS.ProcessEnv, authority: ReviewProofAuthorityFactory }): Promise<ReviewRuntime> {
  const { request } = input
  if (request.toolPolicy?._tag !== 'Review' || request.taskId === undefined)
    throw new Error('The Review tools require controller Task ownership.')
  const ownership = { taskId: request.taskId, headSha: request.toolPolicy.headSha, workerId: request.toolPolicy.workerId, fence: request.toolPolicy.fence }
  const root = await mkdtemp(join(tmpdir(), 'review-runtime-'))
  const tools = join(root, 'tools')
  await mkdir(tools, { mode: 0o700 })
  let home: Awaited<ReturnType<typeof createReviewProviderHome>> | undefined
  let server: Awaited<ReturnType<typeof serveReviewProof>> | undefined
  const release = async () => {
    try {
      await server?.close()
      return await home?.release() ?? { _tag: 'Released' as const, warnings: [] }
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  try {
    const sourceMode = import.meta.url.endsWith('.ts')
    const entry = join(tools, sourceMode ? 'review-mcp.ts' : 'review-mcp.mjs')
    if (sourceMode) {
      for (const name of ['review-mcp.ts', 'review-tools.ts', 'review-static.ts', 'review-proof-transport.ts', 'agent-activity.ts'])
        await copyFile(fileURLToPath(new URL(`./${name}`, import.meta.url)), join(tools, name))
    }
    else {
      await copyFile(fileURLToPath(new URL('../review-mcp.mjs', import.meta.url)), entry)
      await mkdir(join(tools, '_chunks'), { mode: 0o700 })
      await copyFile(fileURLToPath(new URL('./review-proof-transport.mjs', import.meta.url)), join(tools, '_chunks/review-proof-transport.mjs'))
    }
    const socket = join(root, 'proof.sock')
    const command = ['/run/agent/node', '--experimental-strip-types', entry, request.workspace, socket]
    const configuration = input.provider === 'codex'
      ? ['[features]', ...Object.entries(REVIEW_CODEX_FEATURES).map(([name, value]) => `${name} = ${value}`), '[agents]', 'enabled = false', 'max_depth = 0', '[mcp_servers.controller_review]', 'command = "/run/agent/node"', `args = ${JSON.stringify(command.slice(1))}`, 'required = true', 'enabled_tools = ["review_read", "review_search", "review_proof"]', 'default_tools_approval_mode = "approve"', 'omit_tools_from = ["code_mode", "deferred"]'].join('\n')
      : JSON.stringify({ plugin: [], instructions: request.instructionPaths ?? [], permission: { '*': 'deny', ...Object.fromEntries(REVIEW_TOOL_NAMES.map(name => [name, 'allow'])) }, mcp: { controller_review: { type: 'local', command, enabled: true } } })
    const profilePath = join(input.environment.HOME ?? '/home/harlan', '.config/harlan-github-agent/worker.json')
    home = await createReviewProviderHome({ profilePath, provider: input.provider, configuration })
    const reviewHome = home.home
    const launch = createReviewProofLauncher(prepareReviewProofSandbox)
    const proof = createReviewProof({ ledger: join(root, 'source'), workspace: request.workspace, taskId: request.taskId, headSha: request.toolPolicy.headSha, authority: input.authority(ownership), now: () => new Date(), launch })
    server = await serveReviewProof(socket, proof.run)
    return { home: reviewHome, readOnlyPaths: [tools, socket], opencodeConfiguration: input.provider === 'opencode' ? configuration : '{}', release }
  }
  catch (error) {
    await release()
    throw error
  }
}
