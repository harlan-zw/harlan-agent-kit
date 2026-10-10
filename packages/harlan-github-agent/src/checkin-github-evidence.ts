import type { RoutineGitHubEvidence } from './worker-github-evidence.ts'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Give collectors bounded metadata. Controller credentials never enter this file. */
export async function writeCheckinGitHubEvidence(input: {
  workspace: string
  repository: string
  branch: string
  evidence: Pick<RoutineGitHubEvidence, 'observedAt' | 'workflowRuns'> | { _tag: 'Unavailable', reason: string }
}): Promise<void> {
  const workspace = await realpath(input.workspace)
  let directory = join(workspace, 'node_modules')
  if (await realpath(directory) !== directory)
    throw new Error('The check-in evidence directory must stay inside its Worktree.')
  for (const segment of ['.cache', 'harlan-checkin']) {
    directory = join(directory, segment)
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST')
        throw error
    })
    if (await realpath(directory) !== directory)
      throw new Error('The check-in evidence directory must stay inside its Worktree.')
  }
  const evidence = input.evidence
  const snapshot = {
    schemaVersion: 1,
    repository: input.repository,
    branch: input.branch,
    observedAt: 'observedAt' in evidence ? evidence.observedAt : new Date().toISOString(),
    workflowRuns: 'workflowRuns' in evidence ? evidence.workflowRuns : evidence,
  }
  const staging = await mkdtemp(join(directory, '.next-'))
  try {
    await writeFile(join(staging, 'github.json'), JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' })
    // Rename replaces an old snapshot or symlink without following its target.
    await rename(join(staging, 'github.json'), join(directory, 'github.json'))
  }
  finally {
    await rm(staging, { recursive: true })
  }
}
