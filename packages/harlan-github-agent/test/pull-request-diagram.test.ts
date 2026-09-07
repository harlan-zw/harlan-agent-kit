import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SCHEMA_VERSION } from '@coldtea/pr-lens-schema'
import { afterEach, describe, expect, it } from 'vitest'
import { drawPullRequestDiagram, findPullRequestDiagramReference, readPullRequestDiagram } from '../src/pull-request-diagram.ts'

const provenance = { repository: 'harlan-zw/example', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }

function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    kind: 'graph',
    title: 'Stale cache reads',
    summary: 'The handler serves the last good value when a recompute fails.',
    lenses: ['architecture'],
    provenance: { repo: { owner: 'wrong', name: 'wrong' }, base: { sha: 'not-a-sha' }, head: { sha: 'not-a-sha' } },
    lanes: [{ id: 'server', label: 'Server', order: 1 }],
    nodes: [
      { id: 'handler', label: 'skill-related', kind: 'route', delta: 'modified', lane: 'server' },
      { id: 'cache', label: 'readThroughCache', kind: 'function', delta: 'added', lane: 'server' },
    ],
    edges: [{ id: 'handler-cache', from: 'handler', to: 'cache', kind: 'call', delta: 'added', emphasis: 'hero' }],
    flows: [],
    stats: {},
    views: [{ id: 'overview', title: 'Overview', lens: 'architecture', summary: 'The handler reads through the new cache.', defaultOpen: true }],
    ...overrides,
  })
}

const temporaryDirectories: string[] = []
afterEach(() => {
  temporaryDirectories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
})

describe('drawPullRequestDiagram', () => {
  it('draws the open view with the caption its summary gives, whatever provenance the Agent wrote', () => {
    const drawn = drawPullRequestDiagram(document(), provenance)

    expect(drawn).toEqual({ _tag: 'Ok', value: expect.objectContaining({ alt: 'The handler reads through the new cache.' }) })
    if (drawn._tag === 'Err')
      throw new Error(drawn.error)
    expect(drawn.value.svg).toMatch(/^<svg/)
    expect(drawn.value.svg).toContain('readThroughCache')
  })

  it('names the broken reference instead of drawing a document that lies', () => {
    const drawn = drawPullRequestDiagram(document({ edges: [{ id: 'e', from: 'handler', to: 'missing', kind: 'call', delta: 'added' }] }), provenance)

    expect(drawn._tag).toBe('Err')
    if (drawn._tag === 'Ok')
      throw new Error('Expected a rejection.')
    expect(drawn.error).toContain('missing')
  })

  it('says when the document is not JSON', () => {
    expect(drawPullRequestDiagram('{ not json', provenance)).toEqual({ _tag: 'Err', error: expect.stringContaining('not JSON') })
  })

  it('says when a valid document has nothing the open view can draw', () => {
    const drawn = drawPullRequestDiagram(document({
      lenses: ['data-flow'],
      views: [{ id: 'data-flow', title: 'Data flow', lens: 'data-flow', summary: 'How data moves.', defaultOpen: true }],
    }), provenance)

    expect(drawn._tag).toBe('Err')
    if (drawn._tag === 'Ok')
      throw new Error('Expected a rejection.')
    expect(drawn.error).toContain('the data-flow lens needs a flow to draw')
  })
})

describe('readPullRequestDiagram', () => {
  it('reads the document the Agent left in the worktree, and reports a worktree without one', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'harlan-diagram-'))
    temporaryDirectories.push(worktree)
    expect(await readPullRequestDiagram(worktree, provenance)).toEqual({ _tag: 'Absent' })

    mkdirSync(join(worktree, '.pr-lens'))
    writeFileSync(join(worktree, '.pr-lens', 'graph.json'), document())
    expect(await readPullRequestDiagram(worktree, provenance)).toEqual({ _tag: 'Drawn', diagram: expect.objectContaining({ alt: 'The handler reads through the new cache.' }) })

    writeFileSync(join(worktree, '.pr-lens', 'graph.json'), '[]')
    expect(await readPullRequestDiagram(worktree, provenance)).toEqual({ _tag: 'Invalid', reason: expect.any(String) })
  })
})

describe('findPullRequestDiagramReference', () => {
  it('finds the pr-lens skill reference this checkout carries', async () => {
    const reference = await findPullRequestDiagramReference()

    expect(reference).toEqual({
      guide: expect.stringMatching(/skills\/pr-lens\/references\/graph-document\.md$/),
      example: expect.stringMatching(/skills\/pr-lens\/references\/example\.graph\.json$/),
    })
  })

  it('finds the kit from the built chunk, one directory deeper than source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harlan-kit-'))
    temporaryDirectories.push(root)
    const references = join(root, 'harlan-agent-kit', 'skills', 'pr-lens', 'references')
    mkdirSync(references, { recursive: true })
    writeFileSync(join(references, 'graph-document.md'), '# Authoring')
    writeFileSync(join(references, 'example.graph.json'), '{}')
    const chunk = join(root, 'packages', 'harlan-github-agent', 'dist', '_chunks', 'service.mjs')
    mkdirSync(dirname(chunk), { recursive: true })
    writeFileSync(chunk, '')

    expect(await findPullRequestDiagramReference(chunk)).toEqual({
      guide: join(references, 'graph-document.md'),
      example: join(references, 'example.graph.json'),
    })
  })

  it('reports a tree without the reference as none', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'harlan-no-reference-'))
    temporaryDirectories.push(empty)

    expect(await findPullRequestDiagramReference(join(empty, 'service.mjs'))).toBeNull()
  })
})
