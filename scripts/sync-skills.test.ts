import { expect, it } from 'vitest'
import { syncSkills } from './sync-skills.ts'

const input = {
  manifest: '/source/.skills/skilld.json',
  dataRoot: '/home/test/.local/share/harlan-agent-kit/skilld',
  binary: '/tools/skilld',
  check: false,
}

it('uses the declared global Skills without moving the existing skilld store', () => {
  const calls: unknown[] = []
  syncSkills(input, invocation => calls.push(invocation))
  expect(calls).toEqual([expect.objectContaining({
    binary: input.binary,
    args: ['sync', '--manifest', input.manifest, '--global', '--adopt', '--plain'],
    env: expect.objectContaining({ SKILLD_DATA_DIR: input.dataRoot }),
  })])
})

it('checks installed Skills without adopting targets', () => {
  const calls: string[][] = []
  syncSkills({ ...input, check: true }, invocation => calls.push(invocation.args))
  expect(calls).toEqual([['sync', '--manifest', input.manifest, '--global', '--check', '--plain']])
})

it('reports the original skilld failure for missing support or a target conflict', () => {
  const failure = new Error('TARGET_CONFLICT: Skill write-human differs from its source.')
  expect(() => syncSkills(input, () => {
    throw failure
  })).toThrow(failure)
})
