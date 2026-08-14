import type { ThreadEvent } from '@openai/codex-sdk'
import type { AgentProgress } from './types.ts'

export type AgentProgressWork = 'review' | 'issue' | 'conflict' | 'fix'

const changedFilesLabel: Record<AgentProgressWork, string> = {
  review: 'Reviewing changed files',
  issue: 'Checking the issue against the code',
  conflict: 'Resolving merge conflicts',
  fix: 'Repairing review findings',
}

const resultLabel: Record<AgentProgressWork, string> = {
  review: 'Preparing the review comment',
  issue: 'Preparing the issue triage result',
  conflict: 'Checking the conflict fix',
  fix: 'Checking the repair',
}

export function formatProgressBar(percent: number): string {
  const complete = Math.round(percent / 20)
  return `${'▓'.repeat(complete)}${'░'.repeat(5 - complete)} ${percent}%`
}

export function codexEventProgress(event: ThreadEvent, work: AgentProgressWork): AgentProgress | undefined {
  if (event.type === 'item.started') {
    if (event.item.type === 'web_search')
      return { percent: 55, label: 'Checking docs' }
    if (event.item.type === 'command_execution') {
      const runsChecks = /(?:^|\s)(?:build|check|lint|test|typecheck|vitest)(?:\s|$|:)/i.test(event.item.command)
      return runsChecks
        ? { percent: 70, label: 'Running tests and checks' }
        : { percent: 55, label: changedFilesLabel[work] }
    }
    if (event.item.type === 'file_change')
      return { percent: 70, label: 'Editing files' }
  }
  if (event.type === 'turn.completed')
    return { percent: 85, label: resultLabel[work] }
  return undefined
}
