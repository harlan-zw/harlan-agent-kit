import { pipeline, Readable } from 'node:stream'
import { constants, createGzip } from 'node:zlib'

function acceptsGzip(header: string | null): boolean {
  const encodings = (header ?? '').toLowerCase().split(',').map((entry) => {
    const [name, ...parameters] = entry.trim().split(';')
    const quality = parameters.find(value => value.trim().startsWith('q='))?.trim().slice(2)
    return { name: name?.trim(), quality: quality === undefined ? 1 : Number(quality) }
  })
  const encoding = encodings.find(entry => entry.name === 'gzip') ?? encodings.find(entry => entry.name === '*')
  return encoding !== undefined && encoding.quality > 0 && encoding.quality <= 1
}

/** Keep the initial snapshot and live state from monopolizing a phone's connection. */
export function compressResponse(request: Request, response: Response): Response {
  const type = response.headers.get('content-type') ?? ''
  if (response.body === null || response.status === 206 || response.headers.has('content-range')
    || response.headers.has('content-encoding')
    || !/^(?:text\/|application\/(?:json|javascript)(?:;|$))/i.test(type)) {
    return response
  }

  // This is the origin encoder. Preserve no-transform for intermediaries; SSE
  // remains flushable here because the encoder below sync-flushes each chunk.
  const headers = new Headers(response.headers)
  const vary = headers.get('vary')
  if (!vary?.split(',').some(value => ['*', 'accept-encoding'].includes(value.trim().toLowerCase())))
    headers.set('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding')
  if (!acceptsGzip(request.headers.get('accept-encoding')))
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })

  headers.set('content-encoding', 'gzip')
  headers.delete('content-length')
  const source = Readable.fromWeb(response.body)
  const gzip = createGzip({ level: constants.Z_BEST_SPEED, flush: constants.Z_SYNC_FLUSH })
  // Pipeline propagates cancellation/errors both ways, including closing the SSE
  // subscriber when the browser disconnects. Sync flush keeps small heartbeats live.
  pipeline(source, gzip, () => undefined)
  return new Response(Readable.toWeb(gzip, {
    strategy: { highWaterMark: gzip.readableHighWaterMark, size: chunk => chunk.byteLength },
  }) as ReadableStream<Uint8Array>, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
