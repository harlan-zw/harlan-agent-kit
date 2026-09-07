import type { GraphDoc } from '@coldtea/pr-lens-schema'
import type { Result } from './result.ts'
import type { PullRequestDiagram } from './types.ts'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render } from '@coldtea/pr-lens-renderer'
import { formatIssues, graphIntegrityIssues, safeParseGraphDoc } from '@coldtea/pr-lens-schema'
import { isMissingPath } from './agent-context.ts'
import { err, ok } from './result.ts'

/** Where the Agent leaves its graph document, relative to the worktree. */
export const PULL_REQUEST_DIAGRAM_PATH = '.pr-lens/graph.json'

/** The pr-lens skill's authoring guide and its worked example, as absolute paths. */
export interface PullRequestDiagramReference {
  guide: string
  example: string
}

const referencePath = join('harlan-agent-kit', 'skills', 'pr-lens', 'references')

function isFile(path: string): Promise<boolean> {
  return stat(path)
    .then(metadata => metadata.isFile())
    .catch((error: unknown) => {
      if (isMissingPath(error))
        return false
      throw error
    })
}

/**
 * The authoring reference the Agent reads before it writes a graph document.
 *
 * The service checkout is a clone of the whole kit, so the pr-lens skill sits
 * somewhere above this module: three directories up from source, four from
 * the built chunk. Walking the ancestors finds it from either. A checkout
 * without it gets no diagram instructions at all, because a rule that names a
 * file the Agent cannot read costs a turn.
 */
export async function findPullRequestDiagramReference(start = fileURLToPath(import.meta.url)): Promise<PullRequestDiagramReference | null> {
  // The start is this module, or the chunk it was built into.
  let directory = dirname(start)
  while (true) {
    const root = join(directory, referencePath)
    const reference = { guide: join(root, 'graph-document.md'), example: join(root, 'example.graph.json') }
    const present = await Promise.all([isFile(reference.guide), isFile(reference.example)])
    if (present.every(Boolean))
      return reference
    const parent = dirname(directory)
    if (parent === directory)
      return null
    directory = parent
  }
}

export interface PullRequestDiagramProvenance {
  repository: string
  baseSha: string
  headSha: string
}

function withProvenance(value: unknown, provenance: PullRequestDiagramProvenance): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return value
  const [owner, name] = provenance.repository.split('/')
  return {
    ...value,
    provenance: {
      repo: { owner, name },
      base: { sha: provenance.baseSha },
      head: { sha: provenance.headSha },
    },
  }
}

/** The view a reader sees first: the one the document opens, else the first root. */
function topView(doc: GraphDoc): GraphDoc['views'][number] | undefined {
  return doc.views.find(view => view.defaultOpen) ?? doc.views[0]
}

/**
 * One graph document in, the picture a reviewer sees first out.
 *
 * The controller owns provenance, so whatever the Agent wrote there is
 * replaced with the commit it actually published. Everything else is the
 * Agent's, and a document that does not validate names every problem at once
 * so the activity log says what the Agent got wrong.
 */
export function drawPullRequestDiagram(document: string, provenance: PullRequestDiagramProvenance): Result<PullRequestDiagram, string> {
  let value: unknown
  try {
    value = JSON.parse(document)
  }
  catch (error: unknown) {
    return err(`the document is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = safeParseGraphDoc(withProvenance(value, provenance))
  if (!parsed.ok)
    return err(`${parsed.error.message}${parsed.error.issues.length === 0 ? '' : `\n${formatIssues(parsed.error.issues)}`}`)
  const issues = graphIntegrityIssues(parsed.value)
  if (issues.length > 0)
    return err(formatIssues(issues))
  const view = topView(parsed.value)
  const lens = view?.lens ?? (parsed.value.lenses.includes('architecture') ? 'architecture' : parsed.value.lenses[0])
  if (lens === undefined)
    return err('the document declares no lens')
  const drawn = render(parsed.value, { lens, theme: 'dark', ...(view === undefined ? {} : { view: view.id }) })
  return ok({ svg: drawn.svg, alt: view?.summary ?? parsed.value.summary ?? parsed.value.title })
}

export type ReadPullRequestDiagram
  = | { _tag: 'Absent' }
    | { _tag: 'Invalid', reason: string }
    | { _tag: 'Drawn', diagram: PullRequestDiagram }

/** Reads and draws the graph document the Agent left in the worktree, if any. */
export async function readPullRequestDiagram(worktreePath: string, provenance: PullRequestDiagramProvenance): Promise<ReadPullRequestDiagram> {
  const read = await readFile(join(worktreePath, PULL_REQUEST_DIAGRAM_PATH), 'utf8')
    .then(value => ok<string | null>(value))
    .catch((error: unknown): Result<string | null, string> => {
      if (isMissingPath(error))
        return ok(null)
      return err(error instanceof Error ? error.message : String(error))
    })
  if (read._tag === 'Err')
    return { _tag: 'Invalid', reason: `the document could not be read: ${read.error}` }
  if (read.value === null)
    return { _tag: 'Absent' }
  const drawn = drawPullRequestDiagram(read.value, provenance)
  return drawn._tag === 'Ok' ? { _tag: 'Drawn', diagram: drawn.value } : { _tag: 'Invalid', reason: drawn.error }
}
