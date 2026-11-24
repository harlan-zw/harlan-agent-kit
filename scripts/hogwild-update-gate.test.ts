import { describe, expect, it } from 'vitest'
import { decideHogwildUpdate } from './hogwild-update-gate.ts'

describe('decideHogwildUpdate', () => {
  it('refuses controller code, which the nightly Update ships', () => {
    const decision = decideHogwildUpdate({
      _tag: 'ChangedPaths',
      paths: ['packages/harlan-github-agent/src/service.ts', 'harlan-agent-kit/skills/pr/SKILL.md'],
    })

    expect(decision._tag).toBe('Refused')
    expect(decision._tag === 'Refused' && decision.message).toContain('nightly Update')
    expect(decision._tag === 'Refused' && decision.message).toContain('--reason')
  })

  it('refuses a target equal to the deployed commit', () => {
    expect(decideHogwildUpdate({ _tag: 'ChangedPaths', paths: [] })._tag).toBe('Refused')
  })

  it('refuses a desktop test, which never reaches the desktop client', () => {
    const decision = decideHogwildUpdate({
      _tag: 'ChangedPaths',
      paths: ['packages/harlan-github-agent/test/desktop-protocol.test.ts'],
    })

    expect(decision._tag).toBe('Refused')
  })

  it.each([
    'packages/harlan-github-agent/src/desktop-protocol.ts',
    'packages/harlan-github-agent/src/desktop-session-client.ts',
    'scripts/desktop-agent.service',
    'scripts/hogwild-service.conf',
    'scripts/repository-env-files',
    'scripts/repository-env.sh',
  ])('accepts a change to paired file %s', (path) => {
    const decision = decideHogwildUpdate({
      _tag: 'ChangedPaths',
      paths: ['packages/harlan-github-agent/src/service.ts', path],
    })

    expect(decision).toEqual({ _tag: 'Ok', note: `Paired files changed: ${path}` })
  })

  it('accepts an override and records its reason', () => {
    expect(decideHogwildUpdate({ _tag: 'Override', reason: '  Harlan asked\nfor the fix now ' }))
      .toEqual({ _tag: 'Ok', note: 'Update override: Harlan asked for the fix now' })
  })

  it('refuses an override with no reason', () => {
    expect(decideHogwildUpdate({ _tag: 'Override', reason: ' \n ' })._tag).toBe('Refused')
  })
})
