import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

async function namedFile(root: string, name: string, optional = false): Promise<string | null> {
  const file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === 'ENOENT')
      return null
    throw error
  })
  if (file === null)
    return null
  try {
    const path = await realpath(`/proc/self/fd/${file.fd}`)
    const canonicalRoot = await realpath(root)
    const metadata = await file.stat()
    if (!path.startsWith(`${canonicalRoot}/`) || !metadata.isFile() || metadata.size > 100_000)
      throw new Error('The Review provider login must use a bounded file inside the worker home.')
    const buffer = Buffer.alloc(100_001)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 100_000)
      throw new Error('The Review provider login exceeds its byte limit.')
    return buffer.subarray(0, bytesRead).toString('utf8')
  }
  finally {
    await file.close()
  }
}

function namedOpencodeLogin(source: string | null): Record<string, unknown> | undefined {
  if (source === null)
    return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(source) as unknown
  }
  catch {
    throw new Error('The named OpenCode login configuration requires JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || !('provider' in parsed))
    return undefined
  const provider = parsed.provider
  if (typeof provider !== 'object' || provider === null || !('zai-coding-plan' in provider))
    return undefined
  const named = provider['zai-coding-plan']
  if (typeof named !== 'object' || named === null || !('options' in named))
    return undefined
  const options = named.options
  if (typeof options !== 'object' || options === null || !('apiKey' in options) || typeof options.apiKey !== 'string' || options.apiKey.length === 0)
    return undefined
  return { 'zai-coding-plan': { options: { apiKey: options.apiKey } } }
}

/** Copies named provider login files. All executable configuration comes from the controller. */
export async function createReviewProviderHome(input: { profilePath: string, provider: 'codex' | 'opencode', configuration: string }): Promise<{ home: string, release: () => Promise<void> }> {
  const profile = JSON.parse(await readFile(input.profilePath, 'utf8')) as { home?: unknown }
  if (typeof profile.home !== 'string' || !isAbsolute(profile.home))
    throw new Error('The Review worker home must use an absolute path.')
  const home = await mkdtemp(join(tmpdir(), 'review-provider-home-'))
  const release = () => rm(home, { recursive: true, force: true })
  try {
    if (input.provider === 'codex') {
      await mkdir(join(home, '.codex'), { mode: 0o700 })
      await writeFile(join(home, '.codex/auth.json'), (await namedFile(profile.home, '.codex/auth.json'))!, { mode: 0o600 })
      await writeFile(join(home, '.codex/config.toml'), input.configuration, { mode: 0o600 })
      await mkdir(join(home, '.config/opencode'), { recursive: true, mode: 0o700 })
      await writeFile(join(home, '.config/opencode/opencode.json'), '{"permission":{"*":"deny"}}', { mode: 0o600 })
    }
    else {
      await Promise.all([mkdir(join(home, '.local/share/opencode'), { recursive: true, mode: 0o700 }), mkdir(join(home, '.config/opencode'), { recursive: true, mode: 0o700 })])
      const auth = await namedFile(profile.home, '.local/share/opencode/auth.json', true)
      const configured = await namedFile(profile.home, '.config/opencode/opencode.json', true)
      if (auth === null && configured === null)
        throw new Error('The Review worker needs its named OpenCode login.')
      if (auth !== null)
        await writeFile(join(home, '.local/share/opencode/auth.json'), auth, { mode: 0o600 })
      const provider = namedOpencodeLogin(configured)
      if (auth === null && provider === undefined)
        throw new Error('The Review worker needs a supported named OpenCode login.')
      const configuration = JSON.parse(input.configuration) as Record<string, unknown>
      await writeFile(join(home, '.config/opencode/opencode.json'), JSON.stringify({ ...configuration, ...(provider === undefined ? {} : { provider }) }), { mode: 0o600 })
    }
    return { home, release }
  }
  catch (error) {
    await release()
    throw error
  }
}
