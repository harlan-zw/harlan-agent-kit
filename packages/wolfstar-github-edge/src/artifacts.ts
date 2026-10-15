import type { OutboundHandler } from '@cloudflare/containers'
import type { Env } from './env.ts'

/** The hostname the Container asks for snapshot access. Keep in step with `ARTIFACTS_ORIGIN` in the agent package. */
export const ARTIFACTS_HOST = 'artifacts.internal'

/** Short, so a token that leaks from a worktree backup is useless by the next snapshot round. */
const TOKEN_LIFETIME_SECONDS = 15 * 60

/** The shape Artifacts accepts for a repository name, narrowed to what the Container derives. */
const REPOSITORY_NAME = /^[a-z0-9][a-z0-9._-]{1,62}$/

export type AccessScope = 'read' | 'write'

export interface SnapshotAccess {
  /** The git remote the Container pushes to and fetches from. */
  remote: string
  /** A repository token, valid for a few minutes. */
  token: string
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

/**
 * Mints a short lived token for one snapshot repository.
 *
 * A write token creates the repository the first time, so a repository
 * exists only once a worktree has something worth saving. A read token for a
 * repository that does not exist answers null, which tells the Container
 * there is nothing to restore.
 */
export async function issueSnapshotAccess(
  artifacts: Artifacts,
  repository: string,
  scope: AccessScope,
): Promise<SnapshotAccess | null> {
  let handle: ArtifactsRepo
  try {
    handle = await artifacts.get(repository)
  } catch (error) {
    if (!hasCode(error, 'NOT_FOUND')) throw error
    if (scope === 'read') return null
    try {
      await artifacts.create(repository, { description: 'Agent worktree snapshots', setDefaultBranch: 'main' })
    } catch (created) {
      // Another request created it between the lookup and here.
      if (!hasCode(created, 'ALREADY_EXISTS')) throw created
    }
    handle = await artifacts.get(repository)
  }
  using repo = handle
  const [info, token] = await Promise.all([repo.info(), repo.createToken(scope, TOKEN_LIFETIME_SECONDS)])
  return { remote: info.remote, token: token.plaintext }
}

/**
 * Answers `http://artifacts.internal/access` for the Container.
 *
 * The Container cannot hold the binding, so it asks the Worker for a token
 * the same way it reads its journal through `state.internal`. Only the
 * repository name travels, and it is checked against the name rule.
 */
export const artifactsAccess: OutboundHandler<Env> = async (request, env) => {
  const url = new URL(request.url)
  if (url.pathname !== '/access') return new Response('Not found.', { status: 404 })
  if (request.method !== 'POST') return new Response('Method not allowed.', { status: 405 })

  const body = (await request.json().catch(() => null)) as { repository?: unknown; scope?: unknown } | null
  const repository = typeof body?.repository === 'string' ? body.repository : ''
  const scope = body?.scope === 'read' ? 'read' : body?.scope === 'write' ? 'write' : null
  if (!REPOSITORY_NAME.test(repository) || scope === null) return new Response('Invalid request.', { status: 400 })

  try {
    const access = await issueSnapshotAccess(env.ARTIFACTS, repository, scope)
    return access === null ? new Response('Not found.', { status: 404 }) : Response.json(access)
  } catch (error) {
    console.warn('Artifacts access failed.', error)
    return new Response('Artifacts is unavailable.', { status: 502 })
  }
}
