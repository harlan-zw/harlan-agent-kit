import { describe, expect, it } from 'vitest'
import { ask, chance, choice, score } from '../src/index.ts'

const mock = {
  security: { type: 'noul', noul: 0.9 },
  kind: { type: 'choice', choice: 'bug', confidence: 0.8, probabilities: { bug: 0.8, other: 0.2 } },
  noul: { type: 'noul', noul: 0.9 },
  choice: {
    type: 'choice',
    choice: 'bug',
    confidence: 0.8,
    probabilities: { bug: 0.8, other: 0.2 },
  },
  score: {
    type: 'score',
    score: 1.5,
    confidence: 0.7,
    legend: { 0: 'Cosmetic', 1: 'Workaround exists', 2: 'Blocks production' },
    probabilities: { 0: 0, 1: 0.5, 2: 0.5 },
  },
  severity: {
    type: 'score',
    score: 1.5,
    confidence: 0.7,
    legend: { 0: 'Cosmetic', 1: 'Workaround exists', 2: 'Blocks production' },
    probabilities: { 0: 0, 1: 0.5, 2: 0.5 },
  },
}

let seen: { body: { model: string, input: { state: unknown, questions: Record<string, unknown> } } }
const fetch: typeof globalThis.fetch = async (_url, init) => {
  seen = { body: JSON.parse(init!.body as string) }
  // The model answers only the questions it was asked, by name or else by type.
  const answers = Object.fromEntries(
    Object.entries(seen.body.input.questions).map(([name, q]) => [
      name,
      mock[name as keyof typeof mock] ?? mock[(q as { type: keyof typeof mock }).type],
    ]),
  )
  return Response.json({ model: 'jev-1.13.0', answers, usage: { input_tokens: 0, output_tokens: 0 } })
}
const options = { accountId: 'a', apiToken: 'k', fetch }

describe('ask', () => {
  it('sends one batch and returns typed answers', async () => {
    const level = 'issue'
    const result = await ask(
      { title: 'Crash on login', body: 'Anyone can log in as admin with an empty password.' },
      {
        security: 'Does this describe a security vulnerability?',
        kind: ask.choice`What kind of ${level} is this?`({
          bug: 'Something is broken',
          other: null,
        }),
        severity: ask.score`How severe?`(['Cosmetic', 'Workaround exists', 'Blocks production']),
      },
      options,
    )

    expect(seen.body).toEqual({
      model: 'typesafe/jev',
      input: {
        state: {
          title: 'Crash on login',
          body: 'Anyone can log in as admin with an empty password.',
        },
        questions: {
          security: { type: 'noul', instructions: 'Does this describe a security vulnerability?' },
          kind: {
            type: 'choice',
            instructions: 'What kind of issue is this?',
            criteria: { bug: 'Something is broken', other: null },
          },
          severity: {
            type: 'score',
            instructions: 'How severe?',
            criteria: ['Cosmetic', 'Workaround exists', 'Blocks production'],
          },
        },
      },
    })

    expect(result.security.chance).toBe(0.9)
    expect(result.kind.choice).toBe('bug')
    expect(result.severity.score).toBe(1.5)
    expect(result.severity.ratio).toBe(result.severity.score / 2)
    expect(result.severity.legend[2]).toBe('Blocks production')
  })

  it('accepts plain question objects and tags with criteria', async () => {
    const result = await ask(
      'The login page lets anyone in with an empty password.',
      {
        security: chance`Is this a security issue?`({
          true: 'Exploitable',
          false: 'Not exploitable',
        }),
        kind: { type: 'choice', instructions: 'What kind?', criteria: { bug: null, other: null } },
        severity: { type: 'score', instructions: 'Severity?', criteria: ['low', 'mid', 'high'] },
      },
      options,
    )
    expect(seen.body.input.questions.security).toEqual({
      type: 'noul',
      instructions: 'Is this a security issue?',
      criteria: { true: 'Exploitable', false: 'Not exploitable' },
    })
    expect(['bug', 'other']).toContain(result.kind.choice)
    expect(result.severity.ratio).toBeGreaterThanOrEqual(0)
    expect(result.severity.ratio).toBeLessThanOrEqual(1)
  })

  it('tags are plain builders', () => {
    expect(choice`Kind?`({ a: null })).toEqual({
      type: 'choice',
      instructions: 'Kind?',
      criteria: { a: null },
    })
    expect(score`Level?`(['low', 'high'])).toEqual({
      type: 'score',
      instructions: 'Level?',
      criteria: ['low', 'high'],
    })
    expect(chance`Yes?`()).toEqual({ type: 'noul', instructions: 'Yes?', criteria: undefined })
    // `then` stays hidden so the object serializes as a plain question.
    expect(Object.keys(choice`Kind?`({ a: null }))).toEqual(['type', 'instructions', 'criteria'])
  })

  it('ask.if sends one yes/no question about the interpolated state', async () => {
    const issue = { title: 'Checkout is down', body: 'No one can pay.' }
    const result = await ask.if(options)`Does ${issue} affect ${'checkout'} within ${24} hours?`

    expect(seen.body.input.state).toEqual({ input: issue })
    expect(seen.body.input.questions).toEqual({
      input: { type: 'noul', instructions: 'Does `input` affect checkout within 24 hours?' },
    })
    expect(result).toBe(true)
  })

  it('ask.if compares the chance with the threshold', async () => {
    expect(await ask.if(options)`Is ${{ a: 1 }} true?`).toBe(true)
    expect(await ask.if({ ...options, threshold: 0.95 })`Is ${{ a: 1 }} true?`).toBe(false)
  })

  it('ask.if sends several objects as one input array', async () => {
    const issue = { title: 'Checkout is down' }
    const policy = ['Outages are P1']
    await ask.if(options)`Is ${issue} a ${'P1'} under ${policy}?`
    expect(seen.body.input.state).toEqual({ input: [issue, policy] })
    expect(seen.body.input.questions.input).toEqual({
      type: 'noul',
      instructions: 'Is `input[0]` a P1 under `input[1]`?',
    })
  })

  it('ask.if inside ask resolves to a boolean', async () => {
    const result = await ask(
      { title: 'Crash on login' },
      {
        security: ask.if`Is this a security issue?`,
        q: ask.if({ threshold: 0.95 })`Is it urgent?`,
      },
      options,
    )
    expect(seen.body.input.state).toEqual({ title: 'Crash on login' })
    expect(result).toEqual({ security: true, q: false })
  })

  it('tags inside ask send their interpolated objects once each as input', async () => {
    const issue = { title: 'Crash on login' }
    const other = { title: 'Login is slow' }
    const { bug, dupe } = await ask(
      { repo: 'a/b' },
      { bug: ask.if`Is ${issue} a bug?`, dupe: ask.if`Is ${issue} a duplicate of ${other}?` },
      options,
    )
    expect(seen.body.input.state).toEqual({ repo: 'a/b', input: [issue, other] })
    expect(seen.body.input.questions).toEqual({
      bug: { type: 'noul', instructions: 'Is `input[0]` a bug?' },
      dupe: { type: 'noul', instructions: 'Is `input[0]` a duplicate of `input[1]`?' },
    })
    expect(bug).toBe(true)
    expect(dupe).toBe(true)

    await ask(null, { bug: ask.if`Is ${issue} a bug?` }, options)
    expect(seen.body.input.state).toEqual({ input: issue })
    expect(seen.body.input.questions.bug).toEqual({ type: 'noul', instructions: 'Is `input` a bug?' })

    await ask('Triage', { urgent: 'Is this urgent?', bug: ask.if`Is ${issue} a bug?` }, options)
    expect(seen.body.input.state).toEqual({ input: ['Triage', issue] })

    await expect(ask({ input: 1 }, { bug: ask.if`Is ${issue} a bug?` }, options)).rejects.toThrow(
      /already has "input"/,
    )
  })

  it('tags send on their own when awaited', async () => {
    const issue = { title: 'Crash on login' }
    const kind = await ask.choice`What kind of issue is ${issue}?`(
      { bug: null, other: null },
      options,
    )
    expect(seen.body.input.state).toEqual({ input: issue })
    expect(kind.choice).toBe('bug')

    const severity = await ask.score('How severe?', ['low', 'mid', 'high'], options)
    expect(severity.ratio).toBe(0.75)

    const security = await ask.chance`Is ${issue} a security issue?`(undefined, options)
    expect(security.chance).toBe(0.9)
  })

  it('a tag keeps its interpolated objects when reused', async () => {
    const issue = { title: 'Crash on login' }
    const kind = ask.choice`Kind of ${issue}, again ${issue}?`({ bug: null, other: null }, options)
    await ask('Triage', { kind, same: kind }, options)
    expect(seen.body.input.state).toEqual({ input: ['Triage', issue] })
    expect(seen.body.input.questions.kind).toEqual({
      type: 'choice',
      instructions: 'Kind of `input[1]`, again `input[1]`?',
      criteria: { bug: null, other: null },
    })
    expect(kind.instructions).toBe('Kind of `input`, again `input`?')
    expect((await kind).choice).toBe('bug')
  })

  it('validates limits before sending', async () => {
    const opts = { accountId: 'a', apiToken: 'k', fetch: () => Promise.reject(new Error('no')) }
    await expect(ask(null, { c: choice`c`({ only: null }) }, opts)).rejects.toThrow(/2 to 255/)
    await expect(
      ask(
        null,
        { s: { type: 'score', criteria: Array.from({ length: 11 }).fill(null) as never } },
        opts,
      ),
    ).rejects.toThrow(/2 to 10/)
  })
})
