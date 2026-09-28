import type { ConsolaInstance } from 'consola'
import type { ExternalWatchControllerOptions } from '../src/external-watch.ts'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { createExternalWatchReload } from '../src/service.ts'

const silentLogger = { info: (() => undefined) as unknown as ConsolaInstance['info'] }

const temporaryDirectories: string[] = []

afterEach(() => {
  temporaryDirectories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
})

function writeConfig(text: string): string {
  const root = mkdtempSync(join(tmpdir(), 'harlan-github-watch-reload-'))
  temporaryDirectories.push(root)
  const path = join(root, 'config.yml')
  writeFileSync(path, text)
  chmodSync(path, 0o600)
  return path
}

// The watch on nuxt-modules/robots names an owner the allowlist never admits,
// yet startup accepts the same file because loadConfig applies no owner rule
// to external_repositories.
const configText = `
github:
  app_id: 12345
  private_key_path: /home/harlan/.config/harlan-github-agent/app.pem
  allowed_owners: [harlan-zw, nuxt-modules/sitemap]
server:
  host: 127.0.0.1
  port: 3210
  allowed_origin: https://harlan-github-agent.localhost
storage:
  path: ":memory:"
mutations_enabled: false
poll_interval_seconds: 60
issue_cutoff: 2026-07-14
external_repositories:
  - github: nuxt-modules/robots
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

function recordingExternalWatch() {
  const reloads: ExternalWatchControllerOptions[] = []
  return {
    reloads,
    externalWatch: {
      reload: async (next: ExternalWatchControllerOptions) => {
        reloads.push(next)
        return ok({ repositories: next.watches.length, issues: 9 })
      },
    },
  }
}

describe('external watch reload', () => {
  it('applies a watch on an owner the allowlist does not name', async () => {
    const { reloads, externalWatch } = recordingExternalWatch()
    const reload = createExternalWatchReload({
      configPath: writeConfig(configText),
      externalWatch,
      logger: silentLogger,
      now: () => new Date('2026-09-28T00:00:00Z'),
    })

    const result = await reload()

    expect(result).toEqual({ _tag: 'Ok', value: { repositories: 1, issues: 9 } })
    expect(reloads[0]?.watches).toEqual([{ github: 'nuxt-modules/robots', issues: [658] }])
    expect(reloads[0]?.issueCutoff).toBe('2026-07-14')
  })

  it('refuses a configuration file the boundary rejects', async () => {
    const { reloads, externalWatch } = recordingExternalWatch()
    const path = writeConfig(configText)
    chmodSync(path, 0o644)
    const reload = createExternalWatchReload({
      configPath: path,
      externalWatch,
      logger: silentLogger,
      now: () => new Date('2026-09-28T00:00:00Z'),
    })

    const result = await reload()

    expect(result._tag).toBe('Err')
    expect(reloads).toEqual([])
  })
})
