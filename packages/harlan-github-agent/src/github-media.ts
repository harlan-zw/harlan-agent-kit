import type { GitHubTokenProvider } from './github-auth.ts'
import type { Result } from './result.ts'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { findPackageJSON } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { imageSize } from 'image-size'
import { MEDIA_LIMITS } from './github-media-limits.ts'
import { err, ok } from './result.ts'

export { MEDIA_LIMITS } from './github-media-limits.ts'
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
export interface AgentMedia { mime: ImageMime, data: string, label: string, source: string }
export interface MediaReference { url: string, label: string, source?: string }
export interface AgentMediaEvidence { images: AgentMedia[], unavailable: Array<{ label: string, reason: string }> }
export type GitHubMediaSource = (repository: string, references: readonly MediaReference[], signal: AbortSignal) => Promise<AgentMediaEvidence>

/** Only embedded images count. Link prose never substitutes for pixel evidence. */
export function extractMediaReferences(body: string): MediaReference[] {
  const references: MediaReference[] = []
  for (const match of body.matchAll(/!\[([^\]]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)|<img\b[^>]*>/gi)) {
    if (match[2]) {
      references.push({ url: match[2], label: match[1] || 'Image' })
    }
    else {
      const url = match[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]
      if (url)
        references.push({ url: url.replaceAll('&amp;', '&'), label: match[0].match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] || 'Image' })
    }
  }
  return references.map(reference => ({ ...reference, label: reference.label.slice(0, 200) }))
}

/** Rendered GitHub HTML contains signed private image URLs. Keep raw references for Agent-facing evidence. */
export function renderedMediaReferences(raw: string, rendered: string | undefined): MediaReference[] {
  const original = extractMediaReferences(raw)
  const pixels = rendered === undefined ? [] : extractMediaReferences(rendered)
  return original.map((reference, index) => ({ ...reference, ...(pixels.length === original.length ? { url: pixels[index]!.url, source: reference.url } : {}) }))
}

function githubImageHost(host: string): boolean {
  return ['user-images.githubusercontent.com', 'private-user-images.githubusercontent.com', 'media.githubusercontent.com', 'objects.githubusercontent.com'].includes(host)
}

function safeUrl(value: string, redirected: boolean): URL | null {
  const url = URL.canParse(value) ? new URL(value) : null
  if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443'))
    return null
  const github = url.hostname === 'github.com' && url.pathname.startsWith('/user-attachments/assets/')
  const signedAsset = redirected && /^github-production-user-asset-[a-z0-9-]+\.s3\.amazonaws\.com$/.test(url.hostname)
  return github || githubImageHost(url.hostname) || signedAsset ? url : null
}

function imageSignature(bytes: Buffer, mime: ImageMime): boolean {
  if (mime === 'image/png')
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mime === 'image/jpeg')
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (mime === 'image/gif')
    return /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
  return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}

function boundedDimensions(bytes: Buffer): void {
  const dimensions = imageSize(bytes)
  if (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height) || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > MEDIA_LIMITS.dimension || dimensions.height > MEDIA_LIMITS.dimension || dimensions.width * dimensions.height > MEDIA_LIMITS.pixels)
    throw new Error('Image exceeds the pixel limit.')
}

/** Parse transferred media once, before a provider sees it on either host. */
export function parseAgentMedia(value: unknown): AgentMedia[] {
  if (value === undefined)
    return []
  if (!Array.isArray(value) || value.length > MEDIA_LIMITS.count)
    throw new Error('Agent image evidence exceeds the count limit.')
  let total = 0
  return value.map((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || !('mime' in candidate) || !('data' in candidate) || !('label' in candidate) || !('source' in candidate)
      || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(String(candidate.mime))
      || typeof candidate.data !== 'string' || typeof candidate.label !== 'string' || candidate.label.length > 200
      || typeof candidate.source !== 'string' || safeUrl(candidate.source, false) === null || new URL(candidate.source).search !== '' || new URL(candidate.source).hash !== ''
      || candidate.data.length > Math.ceil(MEDIA_LIMITS.imageBytes / 3) * 4 || !/^[A-Z0-9+/]*={0,2}$/i.test(candidate.data)) {
      throw new Error('Agent image evidence is invalid.')
    }
    const bytes = Buffer.from(candidate.data, 'base64')
    total += bytes.length
    const mime = candidate.mime as ImageMime
    if (bytes.length > MEDIA_LIMITS.imageBytes || bytes.length === 0 || total > MEDIA_LIMITS.totalBytes || bytes.toString('base64') !== candidate.data || !imageSignature(bytes, mime))
      throw new Error('Agent image evidence is invalid or exceeds the byte limit.')
    boundedDimensions(bytes)
    return { mime, data: candidate.data, label: candidate.label, source: candidate.source }
  })
}

async function boundedBody(response: Response): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > MEDIA_LIMITS.imageBytes)
    throw new Error('Image exceeds the byte limit.')
  const reader = response.body?.getReader()
  if (!reader)
    throw new Error('Image response has no body.')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done)
        return Buffer.concat(chunks)
      size += chunk.value.byteLength
      if (size > MEDIA_LIMITS.imageBytes)
        throw new Error('Image exceeds the byte limit.')
      chunks.push(chunk.value)
    }
  }
  finally {
    await reader.cancel()
  }
}

/** Native SVG work runs in a killable process. No credentials or temporary files enter it. */
export function renderSvgPixels(bytes: Buffer, signal: AbortSignal, options: { executablePath?: string, timeoutMs?: number } = {}): Promise<Result<Buffer, string>> {
  const extension = fileURLToPath(import.meta.url).endsWith('.ts') ? 'ts' : 'mjs'
  const metadata = findPackageJSON(import.meta.url)
  if (metadata === undefined)
    throw new Error('SVG renderer package metadata is unavailable.')
  const executable = options.executablePath ?? join(dirname(metadata), extension === 'ts' ? 'src' : 'dist', `github-media-render.${extension}`)
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['--max-old-space-size=64', '--experimental-strip-types', executable], {
      encoding: 'buffer',
      timeout: options.timeoutMs ?? 5000,
      killSignal: 'SIGKILL',
      maxBuffer: MEDIA_LIMITS.imageBytes,
      signal,
      env: {},
    }, (error, stdout, stderr) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      if (error === null) {
        resolve(ok(stdout))
        return
      }
      const reason = stderr.toString()
      const known = ['SVG contains unsupported external resources.', 'SVG exceeds the pixel limit or references external images.', 'Rendered image exceeds the byte limit.', 'Image exceeds the byte limit.']
      resolve(err(known.includes(reason) ? reason : 'SVG rendering failed or exceeded its time limit.'))
    })
    // A timeout can close stdin during transfer. The completion callback owns that failure.
    child.stdin?.on('error', () => {})
    child.stdin?.end(bytes)
  })
}

async function pixelImage(bytes: Buffer, contentType: string, signal: AbortSignal): Promise<{ bytes: Buffer, mime: ImageMime }> {
  const mime = contentType.split(';')[0]?.trim().toLowerCase()
  if (mime === 'image/svg+xml') {
    const rendered = await renderSvgPixels(bytes, signal)
    if (rendered._tag === 'Err')
      throw new Error(rendered.error)
    return { bytes: rendered.value, mime: 'image/png' }
  }
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime ?? '') || !imageSignature(bytes, mime as ImageMime))
    throw new Error('Image MIME or signature is unsupported.')
  boundedDimensions(bytes)
  return { bytes, mime: mime as ImageMime }
}

/** Controller-only read credentials never enter a turn, a prompt, or a redirect to another origin. */
export function createGitHubMediaSource(options: { tokens: GitHubTokenProvider, fetch: typeof globalThis.fetch }): GitHubMediaSource {
  return async (repository, references, signal) => {
    const result: AgentMediaEvidence = { images: [], unavailable: [] }
    let total = 0
    for (const reference of references.slice(0, MEDIA_LIMITS.count)) {
      const initial = safeUrl(reference.url, false)
      if (initial === null) {
        result.unavailable.push({ label: reference.label, reason: 'Image source is outside the GitHub media allowlist.' })
        continue
      }
      const token = await options.tokens.getToken(repository, 'read', signal)
      if (token._tag === 'Err') {
        result.unavailable.push({ label: reference.label, reason: 'Read access unavailable. Controller credentials were not upgraded.' })
        continue
      }
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      try {
        let url = initial
        let authenticate = true
        for (let redirects = 0; ; redirects++) {
          const response = await options.fetch(url.href, { redirect: 'manual', signal: deadline, headers: authenticate ? { Authorization: `Bearer ${token.value.token}` } : {} })
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel()
            const location = response.headers.get('location')
            const next = location === null ? null : safeUrl(new URL(location, url).href, true)
            if (next === null || redirects >= MEDIA_LIMITS.redirects)
              throw new Error('Image redirect is unsafe or exceeds the redirect limit.')
            authenticate = authenticate && next.origin === url.origin
            url = next
            continue
          }
          if (!response.ok) {
            await response.body?.cancel()
            throw new Error(`Image retrieval returned HTTP ${response.status}.`)
          }
          const image = await pixelImage(await boundedBody(response), response.headers.get('content-type') ?? '', deadline)
          total += image.bytes.length
          if (total > MEDIA_LIMITS.totalBytes)
            throw new Error('Image evidence exceeds the total byte limit.')
          // Signed redirect query strings never reach the Agent.
          const original = new URL(reference.source ?? initial.href)
          const source = original.origin + original.pathname
          result.images.push({ mime: image.mime, data: image.bytes.toString('base64'), label: reference.label.slice(0, 200), source })
          break
        }
      }
      catch (error) {
        signal.throwIfAborted()
        // Fetch errors can contain URLs or headers. Only our fixed domain errors are safe evidence.
        const reasons = [
          'Image exceeds the byte limit.',
          'Image response has no body.',
          'SVG contains unsupported external resources.',
          'SVG exceeds the pixel limit or references external images.',
          'Rendered image exceeds the byte limit.',
          'Image MIME or signature is unsupported.',
          'Image redirect is unsafe or exceeds the redirect limit.',
          'Image evidence exceeds the total byte limit.',
          'Image exceeds the pixel limit.',
          'SVG rendering failed or exceeded its time limit.',
        ]
        const reason = error instanceof Error && (reasons.includes(error.message) || /^Image retrieval returned HTTP \d{3}\.$/.test(error.message)) ? error.message : 'Image retrieval or rendering failed.'
        result.unavailable.push({ label: reference.label.slice(0, 200), reason })
      }
    }
    if (references.length > MEDIA_LIMITS.count)
      result.unavailable.push({ label: 'Additional images', reason: 'Image evidence exceeds the count limit.' })
    return result
  }
}

/** Each provider materializes the same bounded payload on its own host. */
export async function materializeAgentMedia(value: unknown): Promise<{ paths: string[], release: () => Promise<void> }> {
  const images = parseAgentMedia(value)
  if (images.length === 0)
    return { paths: [], release: async () => {} }
  const directory = await mkdtemp(join(tmpdir(), 'agent-image-evidence-'))
  const paths: string[] = []
  try {
    for (const [index, image] of images.entries()) {
      const path = join(directory, `${index}.${image.mime.split('/')[1]}`)
      await writeFile(path, Buffer.from(image.data, 'base64'), { mode: 0o600 })
      paths.push(path)
    }
    return { paths, release: () => rm(directory, { recursive: true }) }
  }
  catch (error) {
    await rm(directory, { recursive: true })
    throw error
  }
}

export function mediaEvidenceLines(evidence: AgentMediaEvidence): string {
  return `Controller image evidence:\n${evidence.images.map((image, index) => `${index + 1}: ${image.label} (${image.source}). Inspect the attached pixels.`).join('\n')}\n${evidence.unavailable.map(image => `${image.label}: ${image.reason} Return a material documentation finding for unavailable evidence.`).join('\n')}`
}

export async function snapshotMedia(source: GitHubMediaSource | undefined, repository: string, snapshot: { body: string, authorComments?: string[], imageReferences?: MediaReference[] }, signal: AbortSignal): Promise<AgentMediaEvidence> {
  const references = snapshot.imageReferences ?? [snapshot.body, ...(snapshot.authorComments ?? [])].flatMap(extractMediaReferences)
  return source === undefined
    ? { images: [], unavailable: references.map(reference => ({ label: reference.label, reason: 'Controller image retrieval is unavailable.' })) }
    : source(repository, references, signal)
}
