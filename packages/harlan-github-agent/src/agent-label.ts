import type { RepositoryMapping, ReviewOutcomeName } from './types.ts'

/**
 * What one Agent label says about an Item right now.
 *
 * `RUNNING` is the Running label: an Agent holds a Task on this Item at this
 * moment. The other three are Review outcomes, which answer for one head
 * commit. They share one set because they are mutually exclusive: an Item an
 * Agent is working on has no settled verdict, and a settled verdict means no
 * Agent is working.
 */
export type AgentLabelState = ReviewOutcomeName | 'RUNNING'

export interface AgentLabelDefinition {
  name: string
  color: string
  description: string
}

/**
 * The label a person reads in a list of issues and pull requests.
 *
 * The canonical comment already states the verdict and the progress, but a
 * person deciding what to open next reads a list, not a list of comments. An
 * issue carries no progress comment at all while triage or issue work runs, so
 * the Running label is the only signal there.
 */
export const AGENT_LABELS = {
  RUNNING: {
    name: 'harlan-agent-running',
    color: '1d76db',
    description: 'An Agent holds a Task on this issue or pull request right now.',
  },
  READY: {
    name: 'harlan-agent-ready',
    color: '0e8a16',
    description: 'The automated Review passed every gate on this head commit.',
  },
  PENDING: {
    name: 'harlan-agent-pending',
    color: 'fbca04',
    description: 'The automated Review is waiting on a gate for this head commit.',
  },
  BLOCKED: {
    name: 'harlan-agent-blocked',
    color: 'd73a4a',
    description: 'The automated Review found a material defect in this head commit.',
  },
} as const satisfies Record<AgentLabelState, AgentLabelDefinition>

/**
 * The label writes one Agent label state needs.
 *
 * `add` is null when the Item already carries the right label, so an unchanged
 * state writes nothing to GitHub. `remove` never names a label outside this
 * set: a person's own labels are theirs.
 */
export interface AgentLabelPlan {
  add: AgentLabelDefinition | null
  remove: string[]
}

const ownedLabels = new Set(Object.values(AGENT_LABELS).map(label => label.name.toLowerCase()))

export function planAgentLabels(state: AgentLabelState, current: string[]): AgentLabelPlan {
  const wanted = AGENT_LABELS[state]
  const present = current.map(label => label.toLowerCase())
  return {
    add: present.includes(wanted.name.toLowerCase()) ? null : wanted,
    // One Item is in one state. A second owned label on the same Item states a
    // second one, so every other owned label goes.
    remove: current.filter(label =>
      ownedLabels.has(label.toLowerCase()) && label.toLowerCase() !== wanted.name.toLowerCase()),
  }
}

/**
 * The Agent labels to strip from an Item that is in none of these states.
 *
 * A verdict label names the head its Review answered for, and GitHub cannot
 * show that head. Once a newer head arrives with no Review behind it, the label
 * reads as a verdict on work nobody reviewed, so it goes until the next Review
 * stamps. The Running label goes with it: no Agent holds a Task here.
 */
export function staleAgentLabels(current: string[]): string[] {
  return current.filter(label => ownedLabels.has(label.toLowerCase()))
}

/**
 * The Item one claimed Task belongs to, or nothing when it has no Item.
 *
 * Read once here, at the scheduler boundary, so the Running label is written
 * from one place instead of six workers each remembering to. A Routine run
 * answers a clock and has no Item, so it returns nothing and writes no label.
 */
export function agentLabelItem(task: object): { repositoryMapping: RepositoryMapping, itemNumber: number } | undefined {
  const candidate = task as { repositoryMapping?: RepositoryMapping, pullRequestNumber?: number, issueNumber?: number }
  const itemNumber = candidate.pullRequestNumber ?? candidate.issueNumber
  return candidate.repositoryMapping === undefined || itemNumber === undefined
    ? undefined
    : { repositoryMapping: candidate.repositoryMapping, itemNumber }
}
