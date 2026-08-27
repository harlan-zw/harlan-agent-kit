import { describe, expect, it } from 'vitest'
import { parseConfigText } from '../src/config.ts'

const base = `
github:
  app_id: 12345
  private_key_path: /home/harlan/.config/harlan-github-agent/app.pem
  allowed_owners: [harlan-zw]
server:
  host: 127.0.0.1
  port: 3210
  allowed_origin: https://harlan-github-agent.localhost
storage:
  path: /home/harlan/.local/share/harlan-github-agent/state.sqlite
mutations_enabled: false
max_open_pull_requests: 8
poll_interval_seconds: 60
issue_cutoff: 2026-07-14
external_repositories: []
repositories: []
`

function parse(extra = ''): ReturnType<typeof parseConfigText> {
  return parseConfigText(`${base}${extra}`)
}

describe('which triggers one machine answers', () => {
  it('answers every trigger when the file says nothing', () => {
    const parsed = parse()

    expect(parsed._tag).toBe('Ok')
    expect(parsed._tag === 'Ok' ? parsed.value.triggers : []).toEqual(['github', 'routine'])
  })

  it('answers routines only, which is what the second machine runs', () => {
    const parsed = parse('triggers: [routine]\n')

    expect(parsed._tag === 'Ok' ? parsed.value.triggers : []).toEqual(['routine'])
  })

  it('answers GitHub only, which is what the desktop keeps', () => {
    const parsed = parse('triggers: [github]\n')

    expect(parsed._tag === 'Ok' ? parsed.value.triggers : []).toEqual(['github'])
  })

  it('refuses an empty list, because a machine that answers nothing is a mistake', () => {
    const parsed = parse('triggers: []\n')

    expect(parsed).toEqual({ _tag: 'Err', error: [{ path: '$.triggers', message: 'Expected at least one trigger.' }] })
  })

  it('refuses a trigger the service does not have', () => {
    const parsed = parse('triggers: [webhook]\n')

    expect(parsed).toEqual({ _tag: 'Err', error: [{ path: '$.triggers', message: 'Expected github or routine.' }] })
  })

  it('refuses a repeated trigger', () => {
    const parsed = parse('triggers: [routine, routine]\n')

    expect(parsed).toEqual({ _tag: 'Err', error: [{ path: '$.triggers', message: 'List every trigger once.' }] })
  })
})
