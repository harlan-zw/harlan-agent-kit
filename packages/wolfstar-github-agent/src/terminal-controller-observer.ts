import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ReadableStreamDefaultReader } from 'node:stream/web'
import { isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const prefix = '/api/maintenance'
const paths = new Set([
  '/state',
  '/events',
  '/reviews',
  '/stats',
  '/workflow-events',
  '/items/pull-request-status',
  '/items/issue-status',
  '/items/pull-request-events',
  '/items/pull-request-diff',
  '/sessions',
])
const maximum = 8 * 1024 * 1024
interface Config {
  origin: string
  passwordFile: string
}
type ConfigResult = { _tag: 'Ok'; value: Config } | { _tag: 'Err'; error: 'InvalidRequest' }

export function parseTerminalControllerObserverConfig(value: unknown): ConfigResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { _tag: 'Err', error: 'InvalidRequest' }
  const config = value as Record<string, unknown>
  if (
    typeof config.origin !== 'string' ||
    typeof config.passwordFile !== 'string' ||
    !isAbsolute(config.passwordFile) ||
    config.passwordFile.includes('\0') ||
    config.passwordFile.length > 4096
  ) {
    return { _tag: 'Err', error: 'InvalidRequest' }
  }
  const origin = URL.parse(config.origin)
  if (!origin || origin.protocol !== 'https:' || origin.origin !== config.origin || origin.username || origin.password)
    return { _tag: 'Err', error: 'InvalidRequest' }
  return { _tag: 'Ok', value: { origin: origin.origin, passwordFile: config.passwordFile } }
}

/** The caller must check local authentication, Host, and Origin before handling. */
export function createTerminalControllerObserver(options: {
  origin: string
  password: string
  fetch?: typeof globalThis.fetch
  log: (message: string, cause: unknown) => void
}) {
  const origin = URL.parse(options.origin)
  if (!origin || origin.protocol !== 'https:' || origin.origin !== options.origin || origin.username || origin.password)
    throw new Error('Invalid controller origin')
  if (!options.password || options.password.includes('\0')) throw new Error('Invalid controller password')
  const fetch = options.fetch ?? globalThis.fetch
  function handles(path: string): boolean {
    return path === prefix || path.startsWith(`${prefix}/`)
  }
  function failure(response: ServerResponse, error: 'InvalidRequest' | 'Unavailable', status: number) {
    if (response.destroyed) return
    if (response.headersSent) {
      response.destroy()
      return
    }
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(JSON.stringify({ _tag: 'Err', error }))
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Only origin-form request targets are accepted. Encoded separators stay unmatched.
    const target = request.url ?? ''
    const path = target.split('?')[0]!
    if (
      !target.startsWith('/') ||
      target.startsWith('//') ||
      target.includes('#') ||
      target.includes('\\') ||
      target.length > 8192 ||
      !paths.has(path.slice(prefix.length)) ||
      !handles(path) ||
      !['GET', 'HEAD'].includes(request.method ?? '')
    ) {
      failure(response, 'InvalidRequest', 405)
      return
    }
    const controller = new AbortController()
    const cancel = () => controller.abort()
    response.once('close', cancel)
    const timeout = setTimeout(cancel, 10000)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const upstream = await fetch(`${options.origin}/api${target.slice(prefix.length)}`, {
        method: request.method ?? 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Authorization: `Basic ${Buffer.from(`agent:${options.password}`).toString('base64')}`,
          Origin: options.origin,
          Accept: path === `${prefix}/events` ? 'text/event-stream' : 'application/json',
        },
      })
      const stream = path === `${prefix}/events`
      const contentType = upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (!upstream.ok || contentType !== (stream ? 'text/event-stream' : 'application/json')) {
        await upstream.body?.cancel()
        failure(response, 'Unavailable', 503)
        return
      }
      if (request.method === 'HEAD') {
        await upstream.body?.cancel()
        response
          .writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          })
          .end()
        return
      }
      if (!upstream.body) {
        failure(response, 'Unavailable', 503)
        return
      }
      reader = upstream.body.getReader()
      if (stream) {
        clearTimeout(timeout)
        let eventBytes = 0
        let lineBytes = 0
        async function* events() {
          while (!controller.signal.aborted) {
            const chunk = await reader!.read()
            if (chunk.done) return
            for (const byte of chunk.value) {
              eventBytes++
              if (eventBytes > maximum) throw new Error('Controller event exceeds limit')
              if (byte === 10) {
                if (lineBytes === 0) eventBytes = 0
                lineBytes = 0
              } else if (byte !== 13) {
                lineBytes++
              }
            }
            yield chunk.value
          }
        }
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        response.flushHeaders()
        await pipeline(Readable.from(events(), { objectMode: false, highWaterMark: 64 * 1024 }), response, {
          signal: controller.signal,
        })
      } else {
        const chunks: Uint8Array[] = []
        let bytes = 0
        while (!controller.signal.aborted) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > maximum) throw new Error('Controller response exceeds limit')
          chunks.push(chunk.value)
        }
        if (controller.signal.aborted) return
        const body = Buffer.concat(chunks)
        // Refuse HTML, invalid JSON, and unknown content types before sending bytes.
        JSON.parse(body.toString('utf8'))
        response
          .writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          })
          .end(body)
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        // Never log the fetch exception. It can include credentials or remote content.
        options.log('Controller observation unavailable', {
          _tag: 'Unavailable',
          kind: cause instanceof Error ? 'Error' : 'Unknown',
        })
      }
      failure(response, 'Unavailable', 503)
    } finally {
      clearTimeout(timeout)
      controller.abort()
      await reader?.cancel().catch(() => {
        // Cancellation races upstream stream completion. No response remains to handle.
      })
      reader?.releaseLock()
      response.removeListener('close', cancel)
    }
  }
  return { handles, handle }
}
