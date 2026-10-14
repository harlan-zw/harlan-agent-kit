import { describe, expect, it } from 'vitest'
import { createPullRequestDiffSource } from '../src/pull-request-diff.ts'

const base = 'a'.repeat(40)
const head = 'b'.repeat(40)
const mergeBase = 'c'.repeat(40)
function fixture(
  transform?: (route: string, parameters: Record<string, string | number>, response: unknown) => unknown,
) {
  let currentHead = head
  const calls: { route: string; parameters: Record<string, string | number> }[] = []
  const source = createPullRequestDiffSource({
    now: () => 1000,
    log: () => {},
    read: async (_repository, route, parameters) => {
      calls.push({ route, parameters })
      const response = (() => {
        if (route.endsWith('/pulls/{number}'))
          return { base: { sha: base }, head: { sha: currentHead }, changed_files: 1 }
        if (route.includes('/compare/')) return { merge_base_commit: { sha: mergeBase } }
        if (route.endsWith('/files')) return [{ filename: 'file.txt', status: 'modified' }]
        if (route.includes('/git/commits/'))
          return { tree: { sha: parameters.sha === mergeBase ? 'd'.repeat(40) : 'e'.repeat(40) } }
        if (route.includes('/git/trees/'))
          return {
            truncated: false,
            tree: [
              {
                path: 'file.txt',
                mode: '100644',
                type: 'blob',
                sha: parameters.sha === 'd'.repeat(40) ? 'f'.repeat(40) : '1'.repeat(40),
                size: 7,
              },
            ],
          }
        if (route.includes('/git/blobs/'))
          return {
            sha: parameters.sha,
            encoding: 'base64',
            size: 7,
            content: Buffer.from(parameters.sha === 'f'.repeat(40) ? 'before\n' : 'after!\n').toString('base64'),
          }
        throw new Error(`Unexpected route ${route}`)
      })()
      return transform ? transform(route, parameters, response) : response
    },
  })
  return {
    source,
    calls,
    changeHead: () => {
      currentHead = '2'.repeat(40)
    },
  }
}

describe('exact Revision pull request diffs', () => {
  it.each(['modified', 'renamed'])('bounds tree requests for deep %s paths', async (status) => {
    const deepPath = `${'d/'.repeat(1000)}file.txt`
    const filename = status === 'renamed' ? 'file.txt' : deepPath
    const { source, calls } = fixture((route, _parameters, response) => {
      if (route.endsWith('/files')) return [{ filename, previous_filename: deepPath, status }]
      if (route.includes('/git/trees/'))
        return {
          truncated: false,
          tree: [
            { path: 'd', mode: '040000', type: 'tree', sha: 'd'.repeat(40) },
            ...(response as { tree: unknown[] }).tree,
          ],
        }
      return response
    })
    const inventory = await source.list(
      { repository: 'owner/repo', number: 1, base, head },
      new AbortController().signal,
    )
    if (inventory._tag !== 'Ok') throw new Error('Expected inventory')
    const listCalls = calls.length
    expect(
      await source.file(
        { repository: 'owner/repo', number: 1, snapshot: inventory.value.id, path: filename },
        new AbortController().signal,
      ),
    ).toEqual({ _tag: 'Err', error: 'TooLarge' })
    expect(calls.length - listCalls).toBe(0)
  })

  it('paginates the GitHub file ceiling and reports incomplete coverage', async () => {
    const { source, calls } = fixture((route, parameters, response) => {
      if (route.endsWith('/pulls/{number}')) return { base: { sha: base }, head: { sha: head }, changed_files: 3005 }
      if (route.endsWith('/files'))
        return Array.from({ length: 100 }, (_, index) => ({
          filename: `page-${parameters.page}-file-${index}`,
          status: 'added',
        }))
      return response
    })
    const inventory = await source.list(
      { repository: 'owner/repo', number: 1, base, head },
      new AbortController().signal,
    )
    expect(inventory).toMatchObject({
      _tag: 'Ok',
      value: { coverage: { _tag: 'Incomplete', reason: 'GitHubFileLimit' } },
    })
    if (inventory._tag !== 'Ok') throw new Error('Expected inventory')
    expect(inventory.value.files).toHaveLength(3000)
    expect(calls.filter((call) => call.route.endsWith('/files')).map((call) => call.parameters.page)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    )
  })
  it.each([
    { mode: '120000', type: 'blob', size: 7, error: 'Symlink' },
    { mode: '160000', type: 'commit', size: 7, error: 'Unavailable' },
    { mode: '100644', type: 'blob', size: 2097153, error: 'TooLarge' },
  ])('refuses unsupported Git content before loading a blob %o', async (entry) => {
    const { source, calls } = fixture((route, _parameters, response) =>
      route.includes('/git/trees/')
        ? { truncated: false, tree: [{ path: 'file.txt', sha: 'f'.repeat(40), ...entry }] }
        : response,
    )
    const inventory = await source.list(
      { repository: 'owner/repo', number: 1, base, head },
      new AbortController().signal,
    )
    if (inventory._tag !== 'Ok') throw new Error('Expected inventory')
    expect(
      await source.file(
        { repository: 'owner/repo', number: 1, snapshot: inventory.value.id, path: 'file.txt' },
        new AbortController().signal,
      ),
    ).toEqual({ _tag: 'Err', error: entry.error })
    expect(calls.some((call) => call.route.includes('/git/blobs/'))).toBe(false)
  })
  it('refuses missing pages instead of claiming complete coverage', async () => {
    const { source } = fixture((route, _parameters, response) =>
      route.endsWith('/pulls/{number}') ? { base: { sha: base }, head: { sha: head }, changed_files: 2 } : response,
    )
    expect(
      await source.list({ repository: 'owner/repo', number: 1, base, head }, new AbortController().signal),
    ).toEqual({ _tag: 'Err', error: 'Unavailable' })
  })
  it('reads pinned merge-base and head blobs without fetching live branches', async () => {
    const { source, calls } = fixture()
    const inventory = await source.list(
      { repository: 'owner/repo', number: 1, base, head },
      new AbortController().signal,
    )
    expect(inventory._tag).toBe('Ok')
    if (inventory._tag !== 'Ok') throw new Error('Expected inventory')
    const file = await source.file(
      { repository: 'owner/repo', number: 1, snapshot: inventory.value.id, path: 'file.txt' },
      new AbortController().signal,
    )
    expect(file).toMatchObject({ _tag: 'Ok', value: { oldText: 'before\n', newText: 'after!\n' } })
    expect(calls.filter((call) => call.route.includes('/git/commits/')).map((call) => call.parameters.sha)).toEqual([
      mergeBase,
      head,
    ])
    expect(inventory.value.coverage).toEqual({ _tag: 'Complete' })
  })

  it('invalidates a cached Revision after a force-push before reading contents', async () => {
    const { source, calls, changeHead } = fixture()
    const inventory = await source.list(
      { repository: 'owner/repo', number: 1, base, head },
      new AbortController().signal,
    )
    if (inventory._tag !== 'Ok') throw new Error('Expected inventory')
    changeHead()
    expect(
      await source.file(
        { repository: 'owner/repo', number: 1, snapshot: inventory.value.id, path: 'file.txt' },
        new AbortController().signal,
      ),
    ).toEqual({ _tag: 'Err', error: 'Changed' })
    expect(calls.some((call) => call.route.includes('/git/blobs/'))).toBe(false)
  })

  it('rejects arbitrary paths and a snapshot from another pull request', async () => {
    const { source } = fixture()
    const inventory = await source.list(
      { repository: 'owner/repo', number: 1, base, head },
      new AbortController().signal,
    )
    if (inventory._tag !== 'Ok') throw new Error('Expected inventory')
    const request = { repository: 'owner/repo', number: 1, snapshot: inventory.value.id, path: '../private' }
    expect(await source.file(request, new AbortController().signal)).toEqual({ _tag: 'Err', error: 'InvalidRequest' })
    expect(await source.file({ ...request, number: 2, path: 'file.txt' }, new AbortController().signal)).toEqual({
      _tag: 'Err',
      error: 'Changed',
    })
  })
})
