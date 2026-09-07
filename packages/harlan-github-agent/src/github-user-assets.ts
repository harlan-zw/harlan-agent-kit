import type { Result } from './result.ts'
import { err, ok } from './result.ts'

export interface UserAssetUpload {
  /** GitHub's numeric id for the repository the asset belongs to. */
  repositoryId: number
  name: string
  contentType: string
  body: string
}

/** Uploads one file to GitHub's user attachments and returns the URL a Markdown image can use. */
export type UploadUserAsset = (upload: UserAssetUpload, signal?: AbortSignal) => Promise<Result<string, string>>

export interface UserAssetUploaderOptions {
  /** Harlan's own token. A GitHub App installation token gets 404 from this endpoint. */
  token: (signal?: AbortSignal) => Promise<string>
  fetch?: typeof fetch
  endpoint?: string
}

const defaultEndpoint = 'https://uploads.github.com'

/**
 * The upload `gh pr create --attach` performs.
 *
 * GitHub has no REST route for pull request images. The CLI posts the bytes to
 * the same endpoint the web editor uses, and the returned URL renders inside
 * any Markdown on GitHub. Only a user token is accepted there, so the
 * controller borrows Harlan's CLI login for this one write and signs nothing
 * with it.
 */
export function createUserAssetUploader(options: UserAssetUploaderOptions): UploadUserAsset {
  const fetchAsset = options.fetch ?? fetch
  const endpoint = options.endpoint ?? defaultEndpoint
  return (upload, signal) => options.token(signal)
    .then(async (token) => {
      const url = new URL('/user-attachments/assets', endpoint)
      url.searchParams.set('name', upload.name)
      url.searchParams.set('content_type', upload.contentType)
      url.searchParams.set('repository_id', String(upload.repositoryId))
      const response = await fetchAsset(url, {
        method: 'POST',
        body: upload.body,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/octet-stream',
        },
        ...(signal === undefined ? {} : { signal }),
      })
      if (!response.ok)
        return err(`GitHub refused the asset upload: HTTP ${response.status}.`)
      const asset = await response.json() as { url?: unknown }
      return typeof asset.url === 'string' && asset.url.length > 0
        ? ok(asset.url)
        : err('GitHub returned no asset URL.')
    })
    .catch((error: unknown): Result<string, string> => err(error instanceof Error ? error.message : 'The asset upload failed.'))
}
