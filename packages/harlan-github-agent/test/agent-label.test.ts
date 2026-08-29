import { describe, expect, it } from 'vitest'
import { AGENT_LABELS, agentLabelItem, planAgentLabels, staleAgentLabels } from '../src/agent-label.ts'

describe('planAgentLabels', () => {
  it('adds the label for the verdict the Review reached', () => {
    expect(planAgentLabels('READY', [])).toEqual({
      add: AGENT_LABELS.READY,
      remove: [],
    })
  })

  it('clears the verdict a head commit no longer holds', () => {
    expect(planAgentLabels('BLOCKED', ['harlan-agent-ready'])).toEqual({
      add: AGENT_LABELS.BLOCKED,
      remove: ['harlan-agent-ready'],
    })
  })

  it('writes nothing when the pull request already states this verdict', () => {
    expect(planAgentLabels('PENDING', ['harlan-agent-pending'])).toEqual({ add: null, remove: [] })
  })

  it('leaves every label the service does not own', () => {
    const plan = planAgentLabels('READY', ['bug', 'harlan-agent-auto-merge', 'harlan-agent-review'])

    expect(plan.remove).toEqual([])
    expect(plan.add).toEqual(AGENT_LABELS.READY)
  })

  it('removes a second verdict GitHub reports in any casing', () => {
    expect(planAgentLabels('READY', ['Harlan-Agent-Blocked', 'harlan-agent-ready']).remove)
      .toEqual(['Harlan-Agent-Blocked'])
  })

  it('takes the Running label off the moment a verdict lands', () => {
    expect(planAgentLabels('READY', ['harlan-agent-running'])).toEqual({
      add: AGENT_LABELS.READY,
      remove: ['harlan-agent-running'],
    })
  })

  it('takes the temporary Review route off when an outcome lands', () => {
    expect(planAgentLabels('READY', ['harlan-agent-review-required'])).toEqual({
      add: AGENT_LABELS.READY,
      remove: ['harlan-agent-review-required'],
    })
  })

  it('takes a stale verdict off the moment an agent starts working', () => {
    expect(planAgentLabels('RUNNING', ['harlan-agent-blocked'])).toEqual({
      add: AGENT_LABELS.RUNNING,
      remove: ['harlan-agent-blocked'],
    })
  })

  it('gives each verdict its own label, so two verdicts never read alike', () => {
    const names = Object.values(AGENT_LABELS).map(label => label.name)

    expect(new Set(names).size).toBe(names.length)
  })

  it('replaces one issue triage result without removing the Running label', () => {
    expect(planAgentLabels('READY_TO_SPEC', [
      'harlan-agent-running',
      'harlan-agent-needs-info',
    ])).toEqual({
      add: AGENT_LABELS.READY_TO_SPEC,
      remove: ['harlan-agent-needs-info'],
    })
  })

  it('keeps the issue triage result while Issue work runs', () => {
    expect(planAgentLabels('RUNNING', ['harlan-agent-ready-to-implement'])).toEqual({
      add: AGENT_LABELS.RUNNING,
      remove: [],
    })
  })

  it('keeps the pull request triage result separate from the manual Review override', () => {
    expect(planAgentLabels('ADVERSARIAL_REVIEW_REQUIRED', [
      'harlan-agent-review-skipped',
      'harlan-agent-review',
      'bug',
    ])).toEqual({
      add: AGENT_LABELS.ADVERSARIAL_REVIEW_REQUIRED,
      remove: ['harlan-agent-review-skipped'],
    })
    expect(AGENT_LABELS.ADVERSARIAL_REVIEW_REQUIRED.name).toBe('harlan-agent-review-required')
  })

  it('never replaces a manual Review override with Review skipped', () => {
    expect(planAgentLabels('ADVERSARIAL_REVIEW_SKIPPED', [
      'harlan-agent-review',
      'harlan-agent-review-skipped',
    ])).toEqual({ add: null, remove: ['harlan-agent-review-skipped'] })
  })
})

describe('staleAgentLabels', () => {
  it('names every verdict on a pull request no Review has answered for', () => {
    expect(staleAgentLabels(['harlan-agent-ready', 'harlan-agent-blocked', 'harlan-agent-review-required'])).toEqual([
      'harlan-agent-ready',
      'harlan-agent-blocked',
      'harlan-agent-review-required',
    ])
  })

  it('leaves every label the service does not own', () => {
    expect(staleAgentLabels(['bug', 'harlan-agent-auto-merge', 'harlan-agent-review'])).toEqual([])
  })

  it('names nothing when the pull request carries no verdict, so nothing is written', () => {
    expect(staleAgentLabels([])).toEqual([])
  })
})

describe('agentLabelItem', () => {
  const repositoryMapping = { github: 'harlan-zw/example' } as never

  it('reads the pull request a Task belongs to', () => {
    expect(agentLabelItem({ repositoryMapping, pullRequestNumber: 24 }))
      .toEqual({ repositoryMapping, itemNumber: 24 })
  })

  it('reads the issue a Task belongs to', () => {
    expect(agentLabelItem({ repositoryMapping, issueNumber: 9 }))
      .toEqual({ repositoryMapping, itemNumber: 9 })
  })

  it('names no Item for a Routine run, so a clock writes no label', () => {
    expect(agentLabelItem({ id: 'routine-run', state: { fence: 1 } })).toBeUndefined()
  })
})
