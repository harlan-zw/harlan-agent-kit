import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClaudeProvider } from '../src/claude-provider.ts'

const fixture = `
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
let input = ''
for await (const chunk of process.stdin) input += chunk
const args = process.argv.slice(2)
const systemPath = args[args.indexOf('--system-prompt-file') + 1]
const record = { args, input: JSON.parse(input), system: readFileSync(systemPath, 'utf8'), systemMode: statSync(systemPath).mode & 0o777, directoryMode: statSync(process.cwd()).mode & 0o777, files: readdirSync(process.cwd()), cwd: process.cwd(), env: { tokens: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, retries: process.env.CLAUDE_CODE_MAX_RETRIES, watchdog: process.env.CLAUDE_CODE_RETRY_WATCHDOG, title: process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, fallback: process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK, traffic: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC } }
writeFileSync(process.env.FIXTURE_RECORD, JSON.stringify(record))
const payload = JSON.parse(process.env.FIXTURE_RESPONSE ?? '{}')
if (process.env.FIXTURE_MODE === 'hang') {
  process.on('SIGTERM', () => {})
  const child = spawn(process.execPath, ['-e', "const fs = require('node:fs'); process.on('SIGTERM', () => {}); setInterval(() => fs.appendFileSync(process.argv[1], '.'), 10)", process.env.FIXTURE_TICKS], { stdio: 'ignore' })
  child.unref()
  setInterval(() => {}, 1000)
} else if (process.env.FIXTURE_MODE === 'oversize') {
  process.stdout.write('🔒'.repeat(10000))
} else {
  process.stderr.write(process.env.FIXTURE_STDERR ?? '')
  process.stdout.write(process.env.FIXTURE_MODE === 'invalid' ? 'invalid-json' : JSON.stringify(payload))
  process.exitCode = Number(process.env.FIXTURE_EXIT ?? '0')
}
`

function success(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    result: 'A bounded answer.',
    usage: { input_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 11, output_tokens: 13 },
    ...overrides,
  }
}

describe('claude provider', () => {
  let directory: string
  let script: string
  let record: string
  let ticks: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'octorun-claude-test-'))
    script = join(directory, 'fixture.ts')
    record = join(directory, 'record.json')
    ticks = join(directory, 'ticks')
    await writeFile(script, fixture)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  function provider(response: Record<string, unknown> = success(), extra: Record<string, string> = {}, options: Record<string, unknown> = {}) {
    return createClaudeProvider({
      stateDir: join(directory, 'state'),
      command: process.execPath,
      args: [script],
      env: { ...process.env, FIXTURE_RECORD: record, FIXTURE_TICKS: ticks, FIXTURE_RESPONSE: JSON.stringify(response), ...extra },
      ...options,
    })
  }

  const request = (signal = new AbortController().signal) => ({ messages: [
    { role: 'system' as const, content: 'Private system instruction.' },
    { role: 'user' as const, content: 'Secret PR content: $(touch /tmp/never-run)' },
    { role: 'assistant' as const, content: 'Prior answer.' },
    { role: 'user' as const, content: 'Follow up.' },
  ], maxOutputTokens: 128, signal })

  it('runs one private text turn with tools disabled and accounts for all cached input', async () => {
    const result = await provider().generate(request())
    expect(result).toEqual({ _tag: 'Ok', value: { text: 'A bounded answer.', usage: { inputTokens: 23, outputTokens: 13, costUsd: null } } })
    const boundary = JSON.parse(await readFile(record, 'utf8'))
    expect(boundary.input).toEqual({ messages: request().messages.filter(message => message.role !== 'system') })
    expect(boundary.system).toContain('Private system instruction.')
    expect(boundary.args.join(' ')).not.toMatch(/Private system|Secret PR|Prior answer|Follow up/)
    expect(boundary.systemMode).toBe(0o600)
    expect(boundary.directoryMode).toBe(0o700)
    expect(boundary.files).toEqual(['system.txt'])
    for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence'])
      expect(boundary.args).toContain(flag)
    for (const [flag, value] of [['--tools', ''], ['--disallowedTools', '*'], ['--mcp-config', '{"mcpServers":{}}'], ['--max-turns', '1'], ['--model', 'claude-opus-5-5'], ['--setting-sources', '']])
      expect(boundary.args[boundary.args.indexOf(flag) + 1]).toBe(value)
    expect(boundary.env).toEqual({ tokens: '128', retries: '0', watchdog: '0', title: '1', fallback: '1', traffic: '1' })
    expect(await readdir(join(directory, 'state', 'claude-turns'))).toEqual([])
  })

  it('reports the CLI cost estimate when present', async () => {
    const result = await provider(success({ total_cost_usd: 0.004 })).generate(request())
    expect(result).toMatchObject({ _tag: 'Ok', value: { usage: { costUsd: 0.004 } } })
  })

  it.each([
    ['malformed JSON', success(), { FIXTURE_MODE: 'invalid' }],
    ['missing usage', success({ usage: undefined }), {}],
    ['negative tokens', success({ usage: { input_tokens: -1, output_tokens: 2 } }), {}],
    ['invalid cached tokens', success({ usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: '3' } }), {}],
    ['null cached tokens', success({ usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: null } }), {}],
    ['unsafe token sum', success({ usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 2, cache_creation_input_tokens: 1 } }), {}],
    ['negative cost', success({ total_cost_usd: -1 }), {}],
    ['extra turns', success({ num_turns: 2 }), {}],
    ['tool requests', success({ tool_calls: [{ name: 'Bash' }] }), {}],
  ])('refuses %s without claiming zero spend', async (_name, response, extra) => {
    const result = await provider(response, extra).generate(request())
    expect(result).toMatchObject({ _tag: 'Err', error: { _tag: 'Permanent' } })
    expect(result._tag === 'Err' && result.error.usage).toBeUndefined()
  })

  it.each([
    ['authentication', 'Invalid API key', 'Authorization'],
    ['capacity', 'Rate limit exceeded', 'Capacity'],
    ['subscription capacity', 'You have hit your session limit', 'Capacity'],
    ['weekly capacity', 'You\'ve hit your weekly limit', 'Capacity'],
    ['model capacity', 'You\'ve hit your Opus limit', 'Capacity'],
    ['spend capacity', 'Credit balance is too low', 'Capacity'],
    ['monthly capacity', 'You\'ve hit your monthly spend limit', 'Capacity'],
    ['network', 'Connection reset', 'Transient'],
    ['configuration', 'Unknown option --safe-mode', 'Configuration'],
    ['unknown', 'Unexpected execution failure', 'Permanent'],
  ])('classifies %s failures without leaking stderr or prompt content', async (_name, message, tag) => {
    const result = await provider({ ...success(), is_error: true, subtype: 'error_during_execution', result: message, usage: undefined }, { FIXTURE_EXIT: '1', FIXTURE_STDERR: 'private-token-and-prompt' }).generate(request())
    expect(result).toMatchObject({ _tag: 'Err', error: { _tag: tag } })
    expect(JSON.stringify(result)).not.toMatch(/private-token|Private system|Secret PR|Prior answer/)
    expect(result._tag === 'Err' && result.error.usage).toBeUndefined()
  })

  it('retains known usage after a failed generation', async () => {
    const result = await provider({ ...success(), is_error: true, result: 'Rate limit exceeded' }, { FIXTURE_EXIT: '1' }).generate(request())
    expect(result).toMatchObject({ _tag: 'Err', error: { _tag: 'Capacity', usage: { inputTokens: 23, outputTokens: 13, costUsd: null } } })
  })

  it('does not start a process for an invalid token limit or an already aborted request', async () => {
    const childStarts: string[] = []
    const adapter = createClaudeProvider({ stateDir: join(directory, 'state'), spawn: ((...args: Parameters<typeof spawn>) => {
      childStarts.push('started')
      return spawn(...args)
    }) as typeof spawn })
    expect(await adapter.generate({ ...request(), maxOutputTokens: 0 })).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } } })
    expect(await adapter.generate(request(AbortSignal.abort()))).toMatchObject({ _tag: 'Err', error: { _tag: 'Permanent', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } } })
    expect(childStarts).toEqual([])
  })

  it('reports a missing CLI as a configuration failure before spend', async () => {
    const result = await createClaudeProvider({ stateDir: join(directory, 'state'), command: join(directory, 'missing-cli') }).generate(request())
    expect(result).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } } })
  })

  it('kills a timed out process group and removes private prompts', async () => {
    const result = await provider(success(), { FIXTURE_MODE: 'hang' }, { timeoutMs: 250 }).generate(request())
    expect(result).toMatchObject({ _tag: 'Err', error: { _tag: 'Transient' } })
    expect(result._tag === 'Err' && result.error.usage).toBeUndefined()
    const stopped = await readFile(ticks, 'utf8')
    await delay(50)
    expect(await readFile(ticks, 'utf8')).toBe(stopped)
    expect(await readdir(join(directory, 'state', 'claude-turns'))).toEqual([])
  })

  it('cancels an active process and retains unknown spend', async () => {
    const controller = new AbortController()
    const result = provider(success(), { FIXTURE_MODE: 'hang' }).generate(request(controller.signal))
    await expect.poll(() => readFile(record, 'utf8').then(() => true).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error))).toBe(true)
    controller.abort()
    expect(await result).toMatchObject({ _tag: 'Err', error: { _tag: 'Permanent' } })
    expect(await readdir(join(directory, 'state', 'claude-turns'))).toEqual([])
  })

  it('bounds response bytes before decoding multibyte output', async () => {
    const result = await provider(success(), { FIXTURE_MODE: 'oversize' }, { maxResponseBytes: 1024 }).generate(request())
    expect(result).toMatchObject({ _tag: 'Err', error: { _tag: 'Permanent' } })
    expect(JSON.stringify(result)).not.toContain('🔒')
  })
})
