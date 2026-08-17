import type { AgentEvent } from './agent-provider.ts'
import type { AgentProgress } from './types.ts'

export type AgentProgressWork = 'review' | 'issue' | 'conflict' | 'fix' | 'baseline'

const changedFilesLabel: Record<AgentProgressWork, string> = {
  review: 'Reviewing changed files',
  issue: 'Checking the issue against the code',
  conflict: 'Resolving merge conflicts',
  fix: 'Repairing review findings',
  baseline: 'Repairing the default branch',
}

const resultLabel: Record<AgentProgressWork, string> = {
  review: 'Preparing the review comment',
  issue: 'Preparing the issue triage result',
  conflict: 'Checking the conflict fix',
  fix: 'Checking the repair',
  baseline: 'Checking the default branch repair',
}

export function formatProgressBar(percent: number): string {
  const complete = Math.round(percent / 20)
  return `${'▓'.repeat(complete)}${'░'.repeat(5 - complete)} ${percent}%`
}

export function agentEventProgress(event: AgentEvent, work: AgentProgressWork): AgentProgress | undefined {
  if (event._tag === 'WebSearch')
    return { percent: 55, label: 'Checking docs' }
  if (event._tag === 'CommandStarted' || event._tag === 'CommandCompleted') {
    const runsChecks = /(?:^|\s)(?:build|check|lint|test|typecheck|vitest)(?:\s|$|:)/i.test(event.command)
    return runsChecks
      ? { percent: 70, label: 'Running tests and checks' }
      : { percent: 55, label: changedFilesLabel[work] }
  }
  if (event._tag === 'FileChanged')
    return { percent: 70, label: 'Editing files' }
  if (event._tag === 'TurnCompleted')
    return { percent: 85, label: resultLabel[work] }
  return undefined
}
