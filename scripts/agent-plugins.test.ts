import type { ProviderState } from './agent-plugins.ts'
import { describe, expect, it } from 'vitest'
import { planPluginSync } from './agent-plugins.ts'

const checkout = '/home/harlan/pkg/harlan-agent-kit'
const absent: ProviderState = { _tag: 'Absent' }
const current = (plugin: 'Missing' | 'Enabled' | 'Disabled'): ProviderState => ({ _tag: 'Present', marketplaceRoot: checkout, plugin })

describe('planPluginSync', () => {
  it('does nothing for a provider that is not installed', () => {
    expect(planPluginSync(checkout, { claude: absent, codex: absent })).toEqual([])
  })

  it('adds the marketplace and installs the Claude plugin on a fresh host', () => {
    expect(planPluginSync(checkout, { claude: { _tag: 'Present', marketplaceRoot: undefined, plugin: 'Missing' }, codex: absent })).toEqual([
      { provider: 'claude', args: ['plugin', 'marketplace', 'add', checkout] },
      { provider: 'claude', args: ['plugin', 'install', 'harlan-agent-kit@harlan-agent-kit', '--scope', 'user'] },
    ])
  })

  it('leaves a current Claude install alone, because Claude reads the checkout in place', () => {
    expect(planPluginSync(checkout, { claude: current('Enabled'), codex: absent })).toEqual([])
  })

  it('refreshes the Codex copy on every sync', () => {
    expect(planPluginSync(checkout, { claude: absent, codex: current('Enabled') })).toEqual([
      { provider: 'codex', args: ['plugin', 'add', 'harlan-agent-kit@harlan-agent-kit'] },
    ])
  })

  it('moves a marketplace that points at another folder, such as a removed worktree', () => {
    const moved: ProviderState = { _tag: 'Present', marketplaceRoot: '/home/harlan/pkg/harlan-agent-kit.feat-x', plugin: 'Enabled' }
    expect(planPluginSync(checkout, { claude: moved, codex: moved })).toEqual([
      { provider: 'claude', args: ['plugin', 'marketplace', 'remove', 'harlan-agent-kit'] },
      { provider: 'claude', args: ['plugin', 'marketplace', 'add', checkout] },
      { provider: 'claude', args: ['plugin', 'install', 'harlan-agent-kit@harlan-agent-kit', '--scope', 'user'] },
      { provider: 'codex', args: ['plugin', 'marketplace', 'remove', 'harlan-agent-kit'] },
      { provider: 'codex', args: ['plugin', 'marketplace', 'add', checkout] },
      { provider: 'codex', args: ['plugin', 'add', 'harlan-agent-kit@harlan-agent-kit'] },
    ])
  })

  it('keeps a plugin the user disabled', () => {
    expect(planPluginSync(checkout, { claude: current('Disabled'), codex: current('Disabled') })).toEqual([])
  })
})
