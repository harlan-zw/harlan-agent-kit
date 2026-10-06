import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createGitHubMediaSource, extractMediaReferences, MEDIA_LIMITS, parseAgentMedia, renderedMediaReferences, renderSvgPixels, snapshotMedia } from '../src/github-media.ts'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>'
function source(fetch: typeof globalThis.fetch, granted = true) {
  return createGitHubMediaSource({
    fetch,
    tokens: {
      getToken: async (_repository, access) => {
        expect(access).toBe('read')
        return granted ? { _tag: 'Ok', value: { token: 'fixture-read-token', expiresAt: '2027-01-01' } } : { _tag: 'Err', error: { repository: 'owner/repo', message: 'Read access unavailable' } }
      },
      invalidate: () => {},
    },
  })
}

describe('controller image evidence', () => {
  it('fetches with read credentials, drops them across redirects, and renders SVG pixels', async () => {
    const requests: Array<{ url: string, authorization: string | null }> = []
    const loader = source(async (input, options) => {
      const url = String(input)
      requests.push({ url, authorization: new Headers(options?.headers).get('authorization') })
      return requests.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://github-production-user-asset-6210df.s3.amazonaws.com/diagram.svg' } })
        : new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })
    })
    const evidence = await loader('owner/repo', [{ url: 'https://github.com/user-attachments/assets/fixture', label: 'Before: chart' }], new AbortController().signal)
    expect(requests.map(request => request.authorization)).toEqual(['Bearer fixture-read-token', null])
    expect(evidence.unavailable).toEqual([])
    expect(evidence.images[0]?.label).toBe('Before: chart')
    expect(evidence.images[0]?.mime).toBe('image/png')
    expect(Buffer.from(evidence.images[0]!.data, 'base64').subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  })

  it.each(['http://github.com/user-attachments/assets/a', 'https://user:pass@github.com/user-attachments/assets/a', 'https://github.com/owner/repo/raw/main/secret', 'https://example.com/image.png'])('refuses unsafe source %s without fetching', async (url) => {
    let calls = 0
    const evidence = await source(async () => {
      calls++
      return new Response(svg)
    })('owner/repo', [{ url, label: 'Image' }], new AbortController().signal)
    expect(calls).toBe(0)
    expect(evidence.unavailable).toHaveLength(1)
  })

  it('refuses a redirected local address without forwarding credentials', async () => {
    let calls = 0
    const evidence = await source(async () => {
      calls++
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/config' } })
    })('owner/repo', [{ url: 'https://github.com/user-attachments/assets/a', label: 'Image' }], new AbortController().signal)
    expect(calls).toBe(1)
    expect(evidence.images).toEqual([])
    expect(evidence.unavailable).toHaveLength(1)
  })

  it('reports missing read permission without retrying or upgrading credentials', async () => {
    let calls = 0
    const evidence = await source(async () => {
      calls++
      return new Response(svg)
    }, false)('owner/repo', [{ url: 'https://github.com/user-attachments/assets/a', label: 'Image' }], new AbortController().signal)
    expect(calls).toBe(0)
    expect(evidence.unavailable[0]?.reason).toContain('Read access unavailable')
  })

  it.each([
    new Response('not an image', { headers: { 'content-type': 'text/html' } }),
    new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'content-length': String(MEDIA_LIMITS.imageBytes + 1) } }),
    new Response('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>', { headers: { 'content-type': 'image/svg+xml' } }),
  ])('refuses unsupported or unsafe media', async (response) => {
    const evidence = await source(async () => response)('owner/repo', [{ url: 'https://github.com/user-attachments/assets/a', label: 'Image' }], new AbortController().signal)
    expect(evidence.images).toEqual([])
    expect(evidence.unavailable).toHaveLength(1)
  })

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><feImage href="file:///etc/passwd"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><use href="file:///etc/passwd"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="9000" height="1"/>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><style>@import "file:///etc/passwd";</style></svg>',
  ])('refuses external SVG resources and oversized dimensions before rendering', async (input) => {
    const evidence = await source(async () => new Response(input, { headers: { 'content-type': 'image/svg+xml' } }))('owner/repo', [{ url: 'https://github.com/user-attachments/assets/a', label: 'Image' }], new AbortController().signal)
    expect(evidence.images).toEqual([])
    expect(evidence.unavailable).toHaveLength(1)
  })

  it('refuses an existing local image referenced through SVG filter href', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-file-boundary-'))
    try {
      const path = join(directory, 'private.png')
      await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABQAAAAKCAYAAAC0VX7mAAAAF0lEQVR4nGNkoDIYNZByMGog5YDqBgIAFJEAC2Vie2MAAAAASUVORK5CYII=', 'base64'))
      const input = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><filter id="filter"><feImage href="${path}"/></filter><rect width="20" height="10" filter="url(#filter)"/></svg>`
      const evidence = await source(async () => new Response(input, { headers: { 'content-type': 'image/svg+xml' } }))('owner/repo', [{ url: 'https://github.com/user-attachments/assets/a', label: 'Image' }], new AbortController().signal)
      expect(evidence.images).toEqual([])
      expect(evidence.unavailable[0]?.reason).toContain('SVG contains unsupported external resources')
    }
    finally {
      await rm(directory, { recursive: true })
    }
  })

  it('bounds streamed bytes without relying on Content-Length', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(MEDIA_LIMITS.imageBytes + 1))
    }, cancel() {
      cancelled = true
    } }), { headers: { 'content-type': 'image/png' } })
    const evidence = await source(async () => response)('owner/repo', [{ url: 'https://github.com/user-attachments/assets/a', label: 'Image' }], new AbortController().signal)
    expect(evidence.images).toEqual([])
    expect(cancelled).toBe(true)
  })

  it('bounds redirects and reference count', async () => {
    let calls = 0
    const evidence = await source(async () => {
      calls++
      return new Response(null, { status: 302, headers: { location: 'https://github.com/user-attachments/assets/next' } })
    })('owner/repo', Array.from({ length: MEDIA_LIMITS.count + 1 }, () => ({ url: 'https://github.com/user-attachments/assets/a', label: 'Image' })), new AbortController().signal)
    expect(calls).toBe(MEDIA_LIMITS.count * (MEDIA_LIMITS.redirects + 1))
    expect(evidence.images).toEqual([])
    expect(evidence.unavailable).toHaveLength(MEDIA_LIMITS.count + 1)
  })

  it('bounds total bytes across individually allowed images', async () => {
    const bytes = Buffer.alloc(MEDIA_LIMITS.imageBytes, 0)
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABQAAAAKCAYAAAC0VX7mAAAAF0lEQVR4nGNkoDIYNZByMGog5YDqBgIAFJEAC2Vie2MAAAAASUVORK5CYII=', 'base64').copy(bytes)
    const evidence = await source(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }))('owner/repo', Array.from({ length: 4 }, () => ({ url: 'https://github.com/user-attachments/assets/a', label: 'Image' })), new AbortController().signal)
    expect(evidence.images).toHaveLength(3)
    expect(evidence.unavailable[0]?.reason).toContain('total byte limit')
    expect(() => parseAgentMedia([...evidence.images, evidence.images[0]])).toThrow()
  })

  it('refuses oversized raster dimensions before provider delivery', async () => {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABQAAAAKCAYAAAC0VX7mAAAAF0lEQVR4nGNkoDIYNZByMGog5YDqBgIAFJEAC2Vie2MAAAAASUVORK5CYII=', 'base64')
    bytes.writeUInt32BE(MEDIA_LIMITS.dimension + 1, 16)
    const evidence = await source(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }))('owner/repo', [{ url: 'https://github.com/user-attachments/assets/a', label: 'Image' }], new AbortController().signal)
    expect(evidence.images).toEqual([])
    expect(evidence.unavailable).toHaveLength(1)
    expect(() => parseAgentMedia([{ mime: 'image/png', data: bytes.toString('base64'), label: 'Image', source: 'https://github.com/user-attachments/assets/a' }])).toThrow()
  })

  it('uses the rendered private image URL but delivers only its raw source and label', async () => {
    const raw = '![Before: diagram](https://github.com/user-attachments/assets/a)'
    const rendered = '<img src="https://private-user-images.githubusercontent.com/123/a.svg?jwt=fixture-signed-access" alt="Before: diagram">'
    const requested: string[] = []
    const evidence = await snapshotMedia(source(async (input) => {
      requested.push(String(input))
      return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } })
    }), 'owner/repo', { body: raw, imageReferences: renderedMediaReferences(raw, rendered) }, new AbortController().signal)
    expect(requested).toEqual(['https://private-user-images.githubusercontent.com/123/a.svg?jwt=fixture-signed-access'])
    expect(evidence.images[0]).toMatchObject({ source: 'https://github.com/user-attachments/assets/a', label: 'Before: diagram' })
    expect(JSON.stringify(evidence)).not.toContain('fixture-signed-access')
  })

  it('reports an expired signed image without retrying another credential or URL', async () => {
    let calls = 0
    const evidence = await source(async () => {
      calls++
      return new Response(null, { status: 404 })
    })('owner/repo', [{ url: 'https://private-user-images.githubusercontent.com/a.png?jwt=expired-fixture', source: 'https://github.com/user-attachments/assets/a', label: 'Image' }], new AbortController().signal)
    expect(calls).toBe(1)
    expect(evidence.images).toEqual([])
    expect(evidence.unavailable[0]?.reason).toBe('Image retrieval returned HTTP 404.')
    expect(JSON.stringify(evidence)).not.toContain('expired-fixture')
  })

  it('hides signed request details in fetch and renderer failures', async () => {
    const evidence = await source(async () => {
      throw new Error('Image failed: jwt=fixture-signed-access')
    })('owner/repo', [{ url: 'https://private-user-images.githubusercontent.com/a.svg?jwt=fixture-signed-access', label: 'Image' }], new AbortController().signal)
    expect(evidence.unavailable[0]?.reason).toBe('Image retrieval or rendering failed.')
    expect(JSON.stringify(evidence)).not.toContain('fixture-signed-access')
  })

  it('kills a rendering subprocess that blocks its event loop', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-render-timeout-'))
    try {
      const executablePath = join(directory, 'hang.ts')
      const marker = join(directory, 'ready')
      await writeFile(executablePath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ready'); while (true) {}`)
      const started = Date.now()
      const result = await renderSvgPixels(Buffer.from(svg), new AbortController().signal, { executablePath, timeoutMs: 500 })
      expect(result._tag).toBe('Err')
      expect(await readFile(marker, 'utf8')).toBe('ready')
      expect(Date.now() - started).toBeLessThan(2000)
    }
    finally {
      await rm(directory, { recursive: true })
    }
  })

  it('kills rendering when the controller cancels', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-render-abort-'))
    try {
      const executablePath = join(directory, 'hang.ts')
      const marker = join(directory, 'ready')
      await writeFile(executablePath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ready'); while (true) {}`)
      const controller = new AbortController()
      const pending = renderSvgPixels(Buffer.from(svg), controller.signal, { executablePath, timeoutMs: 5000 })
      await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('ready'))
      controller.abort()
      await expect(pending).rejects.toThrow()
    }
    finally {
      await rm(directory, { recursive: true })
    }
  })

  it('extracts embedded Markdown and HTML image labels', () => {
    expect(extractMediaReferences('![Before: screen](https://github.com/user-attachments/assets/a) <img src="https://user-images.githubusercontent.com/a.png" alt="After">')).toEqual([
      { url: 'https://github.com/user-attachments/assets/a', label: 'Before: screen' },
      { url: 'https://user-images.githubusercontent.com/a.png', label: 'After' },
    ])
  })

  it('rejects malformed media at the portable turn boundary', () => {
    expect(() => parseAgentMedia([{ mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAKCAYAAAC0VX7mAAAAF0lEQVR4nGNkoDIYNZByMGog5YDqBgIAFJEAC2Vie2MAAAAASUVORK5CYII=', label: 'Image', source: 'https://private-user-images.githubusercontent.com/a.png?jwt=fixture-read-grant' }])).toThrow()

    expect(() => parseAgentMedia([{ mime: 'image/png', data: 'not base64!', label: 'Image', source: 'https://github.com/user-attachments/assets/a' }])).toThrow()
    expect(() => parseAgentMedia(Array.from({ length: MEDIA_LIMITS.count + 1 }, () => ({ mime: 'image/png', data: 'a'.repeat(24), label: 'Image', source: 'https://github.com/user-attachments/assets/a' })))).toThrow()
  })
})
