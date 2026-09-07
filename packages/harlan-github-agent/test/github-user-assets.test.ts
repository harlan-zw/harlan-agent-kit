import { describe, expect, it } from 'vitest'
import { createUserAssetUploader } from '../src/github-user-assets.ts'
import { err, ok } from '../src/result.ts'

const upload = { repositoryId: 42, name: 'pr-lens-overview.svg', contentType: 'image/svg+xml', body: '<svg/>' }

describe('user asset uploader', () => {
  it('posts the bytes where the GitHub CLI does and returns the asset URL', async () => {
    let seen: { url: string, method: string | undefined, authorization: string | undefined, body: unknown } | undefined
    const uploader = createUserAssetUploader({
      token: () => Promise.resolve('gho_secret'),
      fetch: ((input: URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>
        seen = { url: input.toString(), method: init?.method, authorization: headers.Authorization, body: init?.body }
        return Promise.resolve(new Response(JSON.stringify({ url: 'https://github.com/user-attachments/assets/abc' }), { status: 200 }))
      }) as unknown as typeof fetch,
    })

    const result = await uploader(upload)

    expect(result).toEqual(ok('https://github.com/user-attachments/assets/abc'))
    expect(seen).toEqual({
      url: 'https://uploads.github.com/user-attachments/assets?name=pr-lens-overview.svg&content_type=image%2Fsvg%2Bxml&repository_id=42',
      method: 'POST',
      authorization: 'Bearer gho_secret',
      body: '<svg/>',
    })
  })

  it('names the status GitHub answered with instead of a URL', async () => {
    const uploader = createUserAssetUploader({
      token: () => Promise.resolve('gho_secret'),
      fetch: (() => Promise.resolve(new Response('{"message":"Not Found"}', { status: 404 }))) as unknown as typeof fetch,
    })

    expect(await uploader(upload)).toEqual(err('GitHub refused the asset upload: HTTP 404.'))
  })

  it('reports a login the CLI cannot produce as the reason', async () => {
    const uploader = createUserAssetUploader({
      token: () => Promise.reject(new Error('gh: not logged in')),
      fetch: (() => Promise.reject(new Error('never reached'))) as unknown as typeof fetch,
    })

    expect(await uploader(upload)).toEqual(err('gh: not logged in'))
  })
})
