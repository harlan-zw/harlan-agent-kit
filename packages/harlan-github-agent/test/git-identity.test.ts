import { describe, expect, it } from 'vitest'
import { loadGitIdentity } from '../src/git-identity.ts'
import { err, ok } from '../src/result.ts'

describe('git identity', () => {
  it('loads the commit identity from global Git configuration', async () => {
    const result = await loadGitIdentity(key => Promise.resolve(ok(key === 'user.name' ? 'Harlan Wilton' : 'harlan@harlanzw.com')))

    expect(result).toEqual({ _tag: 'Ok', value: { name: 'Harlan Wilton', email: 'harlan@harlanzw.com' } })
  })

  it('rejects an incomplete global Git identity', async () => {
    const result = await loadGitIdentity(key => Promise.resolve(key === 'user.name' ? ok('Harlan Wilton') : err('Global Git user.email is not configured.')))

    expect(result).toEqual({ _tag: 'Err', error: 'Global Git user.email is not configured.' })
  })
})
