import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadGitHubAppPrivateKey, normalizeGitHubRemote, parseConfigText, validateRepositoryMappings } from '../src/config.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  temporaryDirectories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
})

const configText = `
github:
  app_id: 12345
  private_key_path: /home/harlan/.config/harlan-github-agent/app.pem
  allowed_owners: [harlan-zw]
server:
  host: 127.0.0.1
  port: 3210
  allowed_origin: https://harlan-github-agent.localhost
storage:
  path: ${homedir()}/.local/share/harlan-github-agent/state.sqlite
mutations_enabled: false
poll_interval_seconds: 60
issue_cutoff: 2026-07-14
external_repositories:
  - github: nuxt-modules/sitemap
    issues: [658]
repositories:
  - github: harlan-zw/example
    checkout: ${homedir()}/pkg/example
    enabled: true
    ownership: owned
    default_branch: main
    writable_pr_authors: [harlan-zw]
    writable_pr_head_prefixes: [fix/, feat/, chore/]
    issue_work: true
    pr_review: true
    conflict_resolution: true
    take_ownership:
      enabled: false
`

describe('configuration boundary', () => {
  it('accepts the Portless dashboard origin', () => {
    const parsed = parseConfigText(configText)

    expect(parsed._tag === 'Ok' && parsed.value.server.allowedOrigin).toBe('https://harlan-github-agent.localhost')
  })

  it('keeps the Agent provider default when the file names no agent count', () => {
    const parsed = parseConfigText(configText)

    expect(parsed._tag === 'Ok' && parsed.value.agent.maximumActiveAgents).toBeNull()
  })

  it('reads how many Agents may hold a Task at once', () => {
    const parsed = parseConfigText(`${configText}
agent:
  provider: opencode
  maximum_active_agents: 6
`)

    expect(parsed._tag === 'Ok' && parsed.value.agent.maximumActiveAgents).toBe(6)
  })

  it('refuses an agent count that would spend the whole host', () => {
    const parsed = parseConfigText(`${configText}
agent:
  provider: opencode
  maximum_active_agents: 40
`)

    expect(parsed._tag === 'Err' && parsed.error.map(issue => issue.path)).toContain('$.agent.maximum_active_agents')
  })

  it('refuses an agent count below one, which would start nothing', () => {
    const parsed = parseConfigText(`${configText}
agent:
  provider: opencode
  maximum_active_agents: 0
`)

    expect(parsed._tag === 'Err' && parsed.error.map(issue => issue.path)).toContain('$.agent.maximum_active_agents')
  })

  it('reads one Reasoning effort override per Agent provider and role', () => {
    const parsed = parseConfigText(`${configText}
agent:
  provider: opencode
  reasoning_effort:
    opencode:
      review_fix: medium
      pull_request_triage: low
`)

    expect(parsed._tag === 'Ok' && parsed.value.agent.reasoningEffort).toEqual({
      opencode: { review_fix: 'medium', pull_request_triage: 'low' },
    })
  })

  it('keeps every provider default when the file names no Reasoning effort override', () => {
    const parsed = parseConfigText(configText)

    expect(parsed._tag === 'Ok' && parsed.value.agent.reasoningEffort).toEqual({})
  })

  it('refuses a Reasoning effort override for a role no Agent has', () => {
    const parsed = parseConfigText(`${configText}
agent:
  provider: opencode
  reasoning_effort:
    opencode:
      repair: medium
`)

    expect(parsed._tag === 'Err' && parsed.error.map(issue => issue.path)).toContain('$.agent.reasoning_effort.opencode.repair')
  })

  it('refuses a Reasoning effort no Agent provider offers', () => {
    const parsed = parseConfigText(`${configText}
agent:
  provider: opencode
  reasoning_effort:
    opencode:
      review_fix: ultra
`)

    expect(parsed._tag === 'Err' && parsed.error.map(issue => issue.path)).toContain('$.agent.reasoning_effort.opencode.review_fix')
  })

  it('refuses a Reasoning effort override for an unknown Agent provider', () => {
    const parsed = parseConfigText(`${configText}
agent:
  provider: opencode
  reasoning_effort:
    claude:
      review_fix: medium
`)

    expect(parsed._tag === 'Err' && parsed.error.map(issue => issue.path)).toContain('$.agent.reasoning_effort.claude')
  })

  it('accepts an HTTPS Tailscale dashboard origin', () => {
    const parsed = parseConfigText(configText.replace(
      'https://harlan-github-agent.localhost',
      'https://hogwild.tailcad325.ts.net',
    ))

    expect(parsed._tag === 'Ok' && parsed.value.server.allowedOrigin).toBe('https://hogwild.tailcad325.ts.net')
  })

  it('rejects a public or unencrypted dashboard origin', () => {
    const publicOrigin = parseConfigText(configText.replace(
      'https://harlan-github-agent.localhost',
      'https://example.com',
    ))
    const unencrypted = parseConfigText(configText.replace(
      'https://harlan-github-agent.localhost',
      'http://hogwild.tailcad325.ts.net',
    ))

    expect(publicOrigin._tag === 'Err' && publicOrigin.error).toContainEqual({
      path: '$.server.allowed_origin',
      message: 'Expected the local dashboard or an HTTPS Tailscale origin.',
    })
    expect(unencrypted._tag === 'Err' && unencrypted.error).toContainEqual({
      path: '$.server.allowed_origin',
      message: 'Expected the local dashboard or an HTTPS Tailscale origin.',
    })
  })

  it('parses a precise repository policy', () => {
    const result = parseConfigText(configText)

    expect(result).toEqual({
      _tag: 'Ok',
      value: expect.objectContaining({
        github: {
          appId: 12345,
          privateKeyPath: '/home/harlan/.config/harlan-github-agent/app.pem',
          allowedOwners: ['harlan-zw'],
        },
        pollIntervalSeconds: 60,
        issueCutoff: '2026-07-14',
        externalRepositories: [{ github: 'nuxt-modules/sitemap', issues: [658] }],
        repositories: [expect.objectContaining({
          github: 'harlan-zw/example',
          takeOwnership: { _tag: 'Disabled' },
        })],
      }),
    })
  })

  it('leaves auto merge off and caps open pull requests until configured', () => {
    const parsed = parseConfigText(configText)
    expect(parsed._tag === 'Ok' && parsed.value.autoMerge).toEqual({ _tag: 'Disabled' })
    expect(parsed._tag === 'Ok' && parsed.value.maxOpenPullRequests).toBe(8)
    expect(parsed._tag === 'Ok' && parsed.value.repositories[0]?.maxOpenPullRequests).toBeNull()
  })

  it('parses a repository pull request limit', () => {
    const parsed = parseConfigText(configText.replace(
      'issue_work: true',
      'issue_work: true\n    max_open_pull_requests: 4',
    ))

    expect(parsed._tag === 'Ok' && parsed.value.repositories[0]?.maxOpenPullRequests).toBe(4)

    const invalid = parseConfigText(configText.replace(
      'issue_work: true',
      'issue_work: true\n    max_open_pull_requests: 0',
    ))
    expect(invalid._tag === 'Err' && invalid.error).toContainEqual({
      path: '$.repositories[0].max_open_pull_requests',
      message: 'Expected an integer from 1 to 100.',
    })
  })

  it('parses an enabled auto merge policy with its defaults', () => {
    const enabled = parseConfigText(`auto_merge:\n  enabled: true\nmax_open_pull_requests: 3\n${configText}`)
    expect(enabled._tag === 'Ok' && enabled.value.autoMerge).toEqual({
      _tag: 'Enabled',
      minimumConfidence: 100,
      method: 'squash',
    })
    expect(enabled._tag === 'Ok' && enabled.value.maxOpenPullRequests).toBe(3)
  })

  it('rejects an out of range confidence, an unknown merge method, and an invalid limit', () => {
    const confidence = parseConfigText(`auto_merge:\n  enabled: true\n  minimum_confidence: 101\n${configText}`)
    expect(confidence._tag === 'Err' && confidence.error.map(issue => issue.path)).toContain('$.auto_merge.minimum_confidence')

    const method = parseConfigText(`auto_merge:\n  enabled: true\n  method: rocket\n${configText}`)
    expect(method._tag === 'Err' && method.error.map(issue => issue.path)).toContain('$.auto_merge.method')

    const limit = parseConfigText(`max_open_pull_requests: 0\n${configText}`)
    expect(limit._tag === 'Err' && limit.error.map(issue => issue.path)).toContain('$.max_open_pull_requests')
  })

  it('runs Codex until the configuration names another agent provider', () => {
    const parsed = parseConfigText(configText)
    expect(parsed._tag === 'Ok' && parsed.value.agent.provider).toBe('codex')

    const opencode = parseConfigText(`agent:\n  provider: opencode\n${configText}`)
    expect(opencode._tag === 'Ok' && opencode.value.agent.provider).toBe('opencode')
  })

  it('rejects an unknown agent provider', () => {
    const parsed = parseConfigText(`agent:\n  provider: gemini\n${configText}`)
    expect(parsed).toEqual({
      _tag: 'Err',
      error: expect.arrayContaining([{ path: '$.agent.provider', message: 'Expected codex or opencode.' }]),
    })
  })

  it('allows GitHub App permissions to define repository scope', () => {
    const result = parseConfigText(configText.replace(/\nrepositories:[\s\S]*$/, '\nrepositories: []\n'))

    expect(result).toEqual({
      _tag: 'Ok',
      value: expect.objectContaining({ repositories: [] }),
    })
  })

  it('accepts an explicitly allowed GitHub App pull request author', () => {
    const result = parseConfigText(configText.replace(
      'writable_pr_authors: [harlan-zw]',
      'writable_pr_authors: [harlan-zw, "harlan-github-agent[bot]"]',
    ))

    expect(result).toEqual({
      _tag: 'Ok',
      value: expect.objectContaining({
        repositories: [expect.objectContaining({
          writablePullRequestAuthors: ['harlan-zw', 'harlan-github-agent[bot]'],
        })],
      }),
    })
  })

  it('rejects broad or invalid external repository watches', () => {
    const result = parseConfigText(configText.replace(
      'issues: [658]',
      'issues: []',
    ))

    expect(result).toEqual({
      _tag: 'Err',
      error: expect.arrayContaining([
        { path: '$.external_repositories[0].issues', message: 'Expected all or at least one positive issue number.' },
      ]),
    })
  })

  it('rejects an invalid GitHub App boundary', () => {
    const result = parseConfigText(configText
      .replace('app_id: 12345', 'app_id: 0')
      .replace('/home/harlan/.config/harlan-github-agent/app.pem', 'app.pem'))

    expect(result).toEqual({
      _tag: 'Err',
      error: expect.arrayContaining([
        { path: '$.github.app_id', message: 'Expected a positive safe integer.' },
        { path: '$.github.private_key_path', message: 'Expected an absolute path.' },
      ]),
    })
  })

  it('requires an explicit GitHub installation owner allowlist', () => {
    const result = parseConfigText(configText.replace('  allowed_owners: [harlan-zw]\n', ''))

    expect(result).toEqual({
      _tag: 'Err',
      error: expect.arrayContaining([
        { path: '$.github.allowed_owners', message: 'Expected at least one GitHub owner.' },
      ]),
    })
  })

  it('rejects a rolling or invalid issue cutoff', () => {
    const result = parseConfigText(configText.replace('issue_cutoff: 2026-07-14', 'issue_cutoff: 30 days ago'))

    expect(result).toEqual({
      _tag: 'Err',
      error: expect.arrayContaining([
        { path: '$.issue_cutoff', message: 'Expected a valid YYYY-MM-DD date.' },
      ]),
    })
  })

  it('loads only a private GitHub App PEM file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harlan-github-key-'))
    temporaryDirectories.push(root)
    const path = join(root, 'app.pem')
    writeFileSync(path, '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n', { mode: 0o600 })

    expect(await loadGitHubAppPrivateKey(path)).toEqual({
      _tag: 'Ok',
      value: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n',
    })

    chmodSync(path, 0o644)
    expect(await loadGitHubAppPrivateKey(path)).toEqual({
      _tag: 'Err',
      error: [{ path: '$.github.private_key_path', message: 'GitHub App private key must use mode 0600.' }],
    })
  })

  it('rejects non-loopback servers and unsafe ownership', () => {
    const result = parseConfigText(configText
      .replace('127.0.0.1', '0.0.0.0')
      .replace('ownership: owned', 'ownership: external')
      .replace('take_ownership:\n      enabled: false', 'take_ownership:\n      enabled: true\n      production_url: http://example.com\n      required_workflows: []\n      smoke_paths: [health]'))

    expect(result._tag).toBe('Err')
    if (result._tag === 'Err') {
      expect(result.error.map(issue => issue.path)).toEqual(expect.arrayContaining([
        '$.server.host',
        '$.repositories[0].take_ownership.enabled',
        '$.repositories[0].take_ownership.production_url',
        '$.repositories[0].take_ownership.smoke_paths',
      ]))
    }
  })

  it('validates the checkout root and origin', async () => {
    const parsed = parseConfigText(configText)
    expect(parsed._tag).toBe('Ok')
    if (parsed._tag === 'Err')
      return

    const result = await validateRepositoryMappings(parsed.value, {
      currentUserId: 1000,
      getOwnerId: () => Promise.resolve(1000),
      readGitCommonDirectory: checkout => Promise.resolve(`${checkout}/.git`),
      resolvePath: path => Promise.resolve(path),
      readOrigin: () => Promise.resolve('git@github.com:harlan-zw/example.git'),
    })

    expect(result._tag).toBe('Ok')
  })

  it.each([
    ['git@github.com:harlan-zw/example.git'],
    ['https://github.com/harlan-zw/example.git'],
    ['ssh://git@github.com/harlan-zw/example.git'],
  ])('normalizes GitHub remote %s', (remote) => {
    expect(normalizeGitHubRemote(remote)).toBe('harlan-zw/example')
  })
})
