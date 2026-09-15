import type { Octokit } from 'octokit'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { RequestError } from 'octokit'

type RequestOptions = ReturnType<Octokit['request']['endpoint']>
type Response = Awaited<ReturnType<Octokit['request']>>
type Request = (options: RequestOptions) => Promise<Response>

export interface GitHubResponseCache {
  request: (request: Request, options: RequestOptions, token: string) => Promise<Response>
}

/** Every reuse needs GitHub's 304 response. No timer grants freshness. */
export function createGitHubResponseCache(options: { maxEntries?: number, maxBytes?: number } = {}): GitHubResponseCache {
  const entries = new Map<string, { response: Response, bytes: number }>()
  const maxEntries = options.maxEntries ?? 1000
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024
  let bytes = 0
  const remove = (key: string) => {
    bytes -= entries.get(key)?.bytes ?? 0
    entries.delete(key)
  }
  return {
    async request(request, requestOptions, token) {
      const headers = Object.fromEntries(Object.entries(requestOptions.headers).map(([name, value]) => [name.toLowerCase(), value]))
      // Caller-owned conditional and non-JSON requests keep their original semantics.
      if (requestOptions.method !== 'GET' || headers['if-none-match'] !== undefined
        || headers['if-modified-since'] !== undefined || headers.range !== undefined
        || requestOptions.request?.parseSuccessResponseBody === false) {
        return request(requestOptions)
      }
      const key = createHash('sha256').update(JSON.stringify([
        token,
        requestOptions.url,
        Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)),
      ])).digest('hex')
      const cached = entries.get(key)
      const conditional = cached === undefined
        ? requestOptions
        : {
            ...requestOptions,
            headers: { ...requestOptions.headers, 'if-none-match': cached.response.headers.etag },
          }
      const response = await request(conditional).catch((error: unknown) => {
        if (cached !== undefined && error instanceof RequestError && error.status === 304) {
          return { ...structuredClone(cached.response), headers: { ...cached.response.headers, ...error.response?.headers } }
        }
        remove(key)
        throw error
      })
      remove(key)
      if (response.status === 200 && response.headers.etag !== undefined
        && response.headers['content-type']?.includes('json')
        && !response.headers['cache-control']?.includes('no-store')) {
        const size = Buffer.byteLength(JSON.stringify(response))
        if (maxEntries > 0 && size <= maxBytes) {
          while (entries.size > 0) {
            if (entries.size < maxEntries && bytes + size <= maxBytes)
              break
            const oldest = entries.keys().next().value
            if (oldest === undefined)
              break
            remove(oldest)
          }
          entries.set(key, { response: structuredClone(response), bytes: size })
          bytes += size
        }
      }
      return response
    },
  }
}
