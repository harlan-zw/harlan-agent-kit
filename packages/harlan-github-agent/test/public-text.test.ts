import type { Octokit } from 'octokit'
import type { PackageReleaseRecord, ReleaseNote } from '../src/package-release-store.ts'
import type { PublicTextWriter } from '../src/public-text.ts'
import type { ReviewFindingThread, ReviewFindingThreadMirror, ReviewFindingThreadsOutcome } from '../src/review-finding-threads.ts'
import type { ReviewFinding } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { candidateIssueBody, candidateIssueTitle } from '../src/candidate-issue-controller.ts'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { createGitHubIssuePublisher } from '../src/github.ts'
import { nativeReviewBody } from '../src/native-review.ts'
import { packageReleaseStatus } from '../src/package-release-controller.ts'
import { releaseNoteApproval } from '../src/package-release.ts'
import { createPublicTextGuard, encodeEntities, isPublishedForm, privateDetailsFor, publicBody, redactPrivateDetails } from '../src/public-text.ts'
import { ok } from '../src/result.ts'
import { mirrorReviewFindingThreads, reviewFindingThreadBody, reviewFindingThreadFingerprint, reviewFindingThreadMarker } from '../src/review-finding-threads.ts'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

/** The line that replaces any line naming a private detail. */
const removed = '_One line removed: it named a private path or host._'

const details = privateDetailsFor({
  home: '/home/harlan',
  storagePath: '/home/harlan/.local/share/harlan-github-agent/state.sqlite',
  checkoutRoots: ['/home/harlan/pkg', '/home/harlan/sites'],
  workerHomes: ['/home/agent', '/home/harlan/.local/share/harlan-agent-kit/worker-home'],
  serviceOrigins: ['https://harlan-github-agent.localhost', 'https://hogwild.tail1234.ts.net'],
})

/** Every fragment a leak could leave behind. None may survive anywhere in a written body. */
const fragments = ['notes.localhost', 'harlan-github-agent.localhost', 'tail1234', '/notes/', '/scratch', '/home/agent', '/pkg/', '/sites/', 'fixture-', 'pa/ss', 'acquisition', 'handover', '(1).pdf', '(b)', 'secret']

function expectNoFragment(body: string): void {
  for (const fragment of fragments)
    expect(body).not.toContain(fragment)
}

const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
})

function journal() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  return store
}

describe('a private detail split across lines', () => {
  const withheld = '_This text was withheld: it named a private path or host across lines._'

  it.each([
    '<a\nhref="https://notes.\nlocalhost/example">docs</a>',
    '<img\nsrc="https://harlan-github-agent.\nlocalhost/x.png">',
    'Open /home/har\nlan/pkg/example now.',
  ])('withholds the body when only the joined lines name it: %s', (text) => {
    const redacted = redactPrivateDetails(text, details)

    expect(redacted.text).toBe(withheld)
    expect(redacted.text).not.toContain('localhost')
    expect(redacted.hits.length).toBeGreaterThan(0)
  })

  it('keeps the parser markers of a withheld body', () => {
    const source = '<!-- harlan-agent-kit:pr-triage -->\n<!-- reviewed-sha: abc -->\nSee <a\nhref="https://notes.\nlocalhost/example">docs</a>.'

    expect(redactPrivateDetails(source, details).text).toBe(`<!-- harlan-agent-kit:pr-triage -->\n<!-- reviewed-sha: abc -->\n${withheld}`)
  })

  it('reads a withheld body as the published form of its source', () => {
    const source = '<!-- harlan-agent-kit:pr-triage -->\nSee <a\nhref="https://notes.\nlocalhost/example">docs</a>.'

    expect(isPublishedForm(redactPrivateDetails(source, details).text, source)).toBe(true)
    expect(isPublishedForm(`<!-- other -->\n${withheld}`, source)).toBe(false)
  })

  it('keeps a body whose lines only touch at a public boundary', () => {
    const text = 'Line one ends here\n/usr/include stays public.'

    expect(redactPrivateDetails(text, details)).toEqual({ text, hits: [] })
  })
})

describe('review findings on #754, third round', () => {
  it('removes a private URL together with its credentials', () => {
    const redacted = redactPrivateDetails('Clone https://fixture-user:pa/ss@notes.localhost/x now.', details)

    expect(redacted.text).toBe(removed)
    expectNoFragment(redacted.text)
  })

  it('removes a quoted private path together with its suffix', () => {
    const redacted = redactPrivateDetails('Run "cat ~/notes/a(1).pdf" now.', details)

    expect(redacted.text).toBe(removed)
    expectNoFragment(redacted.text)
  })

  it.each([
    'Read [doc][ref] now.\n\n[ref]: <~/notes/a (b).md>',
    'Read [doc][ref] now.\n\n[ref]: https://notes.localhost/a(b)c',
  ])('removes a private Markdown destination together with its tail: %s', (text) => {
    const redacted = redactPrivateDetails(text, details)

    expect(redacted.text).toBe(`Read [doc][ref] now.\n\n${removed}`)
    expectNoFragment(redacted.text)
  })
})

describe('redactPrivateDetails', () => {
  it.each([
    '/home/harlan/public/../notes/private-evidence.md',
    '/home/harlan/public/a/../../notes/private-evidence.md',
    '~/public/../notes/private-evidence.md',
    '~harlan/public/../notes/private-evidence.md',
    '$HOME/public/../notes/private-evidence.md',
    `\${HOME}/public/../notes/private-evidence.md`,
    '/home/harlan/public/%2e%2e/notes/private-evidence.md',
    '/home/harlan/public//./../notes/private-evidence.md',
    '"/home/harlan/public directory/../notes/private-evidence.md"',
    '/home/harlan/public(copy)/../notes/private-evidence.md',
  ])('removes a diagnostic path that resolves through parent segments: %s', (path) => {
    const controllerDetails = privateDetailsFor({ home: '/home/harlan', storagePath: ':memory:', checkoutRoots: [], workerHomes: [], serviceOrigins: [] })
    expect(redactPrivateDetails(`Failed to read ${path}`, controllerDetails)).toEqual({
      text: removed,
      hits: [{ _tag: 'Path', entry: path.includes('/home/harlan/') ? '/home/harlan/notes' : `${path.split('/')[0]}/notes` }],
    })
  })

  it.each([
    'Ran /home/harlan/pkg/harlan-agent-kit.fix-x/packages/a/src/index.ts.',
    'Tilde ~/pkg/example.fix-x/src/a.ts',
    'Variable $HOME/sites/site.fix-y/app.vue',
    'Journal ~/.local/share/harlan-github-agent/worktrees/abc',
    'Cache at /home/agent/.cache/pnpm',
    'Evidence is in ~/scratch.',
    'Ran in /home/agent.',
    'See &#126;/scratch/ci-review&#95;2026/report.md for proof.',
    'Open `~/notes/client handover/acquisition.pdf` first.',
    'Read "~/notes/client handover/acquisition.pdf" first.',
    encodeEntities('The file `~/notes/acquisition(final)[internal].pdf` is stale.'),
    'Read [notes](https://notes.localhost/docs/acquisition(final)/internal.pdf) first.',
    'Read ![notes](~/notes/acquisition\\(final\\).png) first.',
    'See <https://fixture-user:p@ss@notes.localhost/report.md>.',
    encodeEntities('Read [notes](https://fixture-user:secret@notes.localhost/report.md) first.'),
    'See https://notes.localhost.',
    'Open https://harlan-github-agent.localhost/tasks/1 now.',
    'Open https://hogwild.tail1234.ts.net/ now.',
    'Open wss://harlan-github-agent.localhost/terminal now.',
    'Clone ssh://notes.localhost/x first.',
    'See [x](//notes.localhost/y).',
    'Mail fixture-user@notes.localhost about it.',
    'Client acquisition handover: see ~/notes/acme.md',
    '<a href="https://notes.localhost/a b">notes</a>',
  ])('removes a line that names a private detail: %s', (line) => {
    const redacted = redactPrivateDetails(line, details)

    expect(redacted.text).toBe(removed)
    expect(redacted.hits).not.toHaveLength(0)
    expectNoFragment(redacted.text)
  })

  it.each([
    'Set the key in /home/harlan/.config/opencode/opencode.json.',
    'The dev server answers on http://localhost:3000/api/health.',
    'The example config reads /home/harlan/.config/harlan-github-agent/app.pem.',
    'The preview runs at https://example.localhost.',
    'Paths like /home/harlan/scratchpad stay.',
    'A file named /home/harlan/scratch.txt stays.',
    'The host notes.localhost.example.com stays.',
    'The sibling /home/agent&#95;x/cache stays.',
    '~~Old text~~ and $HOMELESS/example stay.',
    '[View code](https://github.com/harlan-zw/example/blob/abc123/fixtures/notes.localhost/README.md#L3)',
    'See https://github.com/harlan-zw/example/blob/abc123/fixtures/notes.localhost/README.md.',
    'Harlan\'s note says it\'s fine.',
  ])('keeps a line a finding may legitimately quote: %s', (text) => {
    expect(redactPrivateDetails(text, details)).toEqual({ text, hits: [] })
  })

  it('changes only the lines that name a private detail', () => {
    const text = 'Two workflows failed on main.\nFull notes: https://notes.localhost/notes/ci-review\n\nThe fix is in main.'

    expect(redactPrivateDetails(text, details)).toEqual({
      text: `Two workflows failed on main.\n${removed}\n\nThe fix is in main.`,
      hits: [{ _tag: 'Link', entry: 'notes.localhost' }],
    })
  })

  it('keeps the blockquote, list, checkbox, and label structure of a removed line', () => {
    expect(redactPrivateDetails([
      '> See ~/notes/a.md.',
      '- Logged (40/100): Spans overlap at ~/pkg/x/src/a.ts.',
      '  Repair: Opening ~/notes/a.md <!-- logged-finding: abc -->',
      '  - [ ] Ask about ~/notes/a.md <!-- logged-finding: abc -->',
    ].join('\n'), details).text).toBe([
      `> ${removed}`,
      `- ${removed}`,
      `  Repair: ${removed} <!-- logged-finding: abc -->`,
      `  - [ ] ${removed} <!-- logged-finding: abc -->`,
    ].join('\n'))
  })

  it('drops an HTML comment that names a private detail, and keeps the others', () => {
    expect(redactPrivateDetails('Text ~/notes/a <!-- marker: ok --> <!-- note: ~/notes/b -->', details).text)
      .toBe(`${removed} <!-- marker: ok -->`)
  })

  it('protects worker aliases while keeping unrelated absolute controller paths public', () => {
    const configured = privateDetailsFor({
      home: '/home/harlan/./',
      storagePath: '/home/harlan/state/../journal/state.sqlite',
      checkoutRoots: ['/home/harlan/pkg/', '/home/harlan-other/sites', '/srv/checkouts'],
      workerHomes: ['/home/harlan/workers/agent', '/home/agent'],
      serviceOrigins: [],
    })
    const kept = ['/home/harlan/sites/example', '/home/harlan/checkouts/example', '/home/harlan/.config/app', '/home/harlan/pkg-extra/example']

    expect(redactPrivateDetails(['~/journal/run', '$HOME/journal/run', '~/workers/agent/cache', '$HOME/workers/agent/cache', '~/pkg/worktree', '$HOME/pkg/worktree', ...kept].join('\n'), configured).text)
      .toBe([...Array.from({ length: 6 }).fill(removed), ...kept].join('\n'))
  })

  it('keeps the local dashboard host private when the configured origin is a Tailscale host', () => {
    const tailscaleOnly = privateDetailsFor({ home: '/home/harlan', storagePath: ':memory:', checkoutRoots: [], workerHomes: [], serviceOrigins: ['https://hogwild.tail1234.ts.net'] })

    expect(redactPrivateDetails('Open https://harlan-github-agent.localhost/tasks/1.', tailscaleOnly).text).toBe(removed)
  })

  it('keeps scratch and notes private for a home directory with one segment', () => {
    const rootHome = privateDetailsFor({ home: '/root', storagePath: ':memory:', checkoutRoots: [], workerHomes: [], serviceOrigins: [] })

    expect(redactPrivateDetails('See ~/notes/a.md.\nSee /root/scratch/b.log.', rootHome).text).toBe(`${removed}\n${removed}`)
  })
})

describe('isPublishedForm', () => {
  it('matches a body with more than 200 removed lines', () => {
    const source = Array.from({ length: 250 }, (_, index) => `Path ${index}: ~/notes/${index}.md`).join('\n')

    expect(isPublishedForm(redactPrivateDetails(source, details).text, source)).toBe(true)
  })

  it('refuses a body whose public lines changed', () => {
    const source = 'Status: READY\nNotes: ~/notes/a.md'

    expect(isPublishedForm(`Status: BLOCKED\nNotes: ${removed}`, source)).toBe(false)
    expect(isPublishedForm(`Status: READY\nOther: ${removed}`, source)).toBe(false)
  })
})

describe('the publish boundary', () => {
  it.each<PublicTextWriter>(['automated review', 'automated triage', 'review comment', 'review', 'comment', 'issue', 'pull request description', 'release comment', 'GitHub release'])('removes the filename of a multiline private HTML destination before sending a %s', async (writer) => {
    for (const destination of ['https://notes.localhost/\nacquisition.pdf', 'file:///home/harlan/notes/\nacquisition.pdf']) {
      for (const tag of [`<a href="${destination}">evidence</a>`, `<img src='${destination}'>`, `<a\ntitle="a &quot; > b" href="${destination}">evidence</a>`]) {
        const input = `Public introduction.\n${tag}\n\nPublic conclusion.`
        const source = writer === 'review' ? encodeEntities(input) : input
        const written: string[] = []

        await publicBody({ details, report: () => {} }, { repository: 'harlan-zw/example', itemNumber: 24, writer }, source).send(async (body) => {
          written.push(body)
        })

        expect(written).toEqual([`Public introduction.\n${Array.from({ length: tag.split('\n').length }).fill(removed).join('\n')}\n\nPublic conclusion.`])
        expectNoFragment(written.join('\n'))
      }
    }
  })

  it.each<PublicTextWriter>(['automated review', 'automated triage', 'review comment', 'review', 'comment', 'issue', 'pull request description', 'release comment', 'GitHub release'])('removes source lines joined by HTML containing entity-encoded quotes before sending a %s', async (writer) => {
    for (const markup of ['<span title="&quot; > context\nmore context"></span>', '<span title=\'&#39; > context\nmore context\'></span>', '<span title="&#x22; > context\nmore context"></span>', '<span title="&quot; > context"></span>']) {
      for (const detail of [`/home/har${markup}lan/notes/acquisition.pdf`, `notes.${markup}localhost/acquisition`]) {
        const input = `Public introduction.\nRead ${detail} now.\nPublic conclusion.`
        const store = journal()
        const guard = createPublicTextGuard({ details, store, now: () => new Date(), log: () => {} })

        const sent = await publicBody(guard, { repository: 'harlan-zw/example', itemNumber: 24, writer }, writer === 'review' ? encodeEntities(input) : input).send(async body => body)

        expect(sent).toBe(`Public introduction.\n${Array.from({ length: markup.split('\n').length }).fill(removed).join('\n')}\nPublic conclusion.`)
        expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail' })])
      }
    }
  })

  it.each<PublicTextWriter>(['automated review', 'automated triage', 'review comment', 'review', 'comment', 'issue', 'pull request description', 'release comment', 'GitHub release'])('removes source lines joined by HTML with quoted angle brackets before sending a %s', async (writer) => {
    for (const markup of ['<span\ntitle="a > b"></span>', '<span title=\'a < b\'\ndata-x></span>', '<span title="a >\nb < c"></span>']) {
      for (const detail of [`/home/har${markup}lan/notes/acquisition.pdf`, `notes.${markup}localhost/acquisition`]) {
        const store = journal()
        const input = `Public introduction.\nRead ${detail} now.\nPublic conclusion.`
        const guard = createPublicTextGuard({ details, store, now: () => new Date(), log: () => {} })

        const sent = await publicBody(guard, { repository: 'harlan-zw/example', itemNumber: 24, writer }, writer === 'review' ? encodeEntities(input) : input).send(async body => body)

        expect(sent).toBe(`Public introduction.\n${removed}\n${removed}\nPublic conclusion.`)
        expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail' })])
      }
    }
  })

  it.each<PublicTextWriter>(['automated review', 'automated triage', 'review comment', 'review', 'comment', 'issue', 'pull request description', 'release comment', 'GitHub release'])('removes local file URI diagnostics and keeps public HTTPS examples before sending a %s', async (writer) => {
    for (const uri of ['file://localhost/home/harlan/notes/acquisition.pdf', 'file://LOCALHOST/home/harlan/notes/acquisition.pdf', 'file:///home/harlan/notes/acquisition.pdf', 'file://localhost/home/harlan/public/../notes/acquisition.pdf', 'file://localhost/%68ome/harlan/notes/acquisition.pdf']) {
      const store = journal()
      const example = 'Read https://example.com/home/harlan/notes/acquisition.pdf for syntax.'
      const input = `Failed to read ${uri}\n${example}`
      const guard = createPublicTextGuard({ details, store, now: () => new Date(), log: () => {} })

      const sent = await publicBody(guard, { repository: 'harlan-zw/example', itemNumber: 24, writer }, writer === 'review' ? encodeEntities(input) : input).send(async body => body)

      expect(sent).toBe(`${removed}\n${example}`)
      expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail' })])
    }
  })

  it.each<PublicTextWriter>(['automated review', 'automated triage', 'review comment', 'review', 'comment', 'issue', 'pull request description', 'release comment', 'GitHub release'])('removes every source line of multiline HTML private details before sending a %s', async (writer) => {
    for (const markup of ['<!-- hidden\nmore hidden\n-->', '<span\ntitle="context"\ndata-x></span>']) {
      for (const detail of [`/home/har${markup}lan/notes/acquisition.pdf`, `notes.${markup}localhost/acquisition`]) {
        const input = `Public introduction.\n\nRead ${detail} now.\n\nPublic conclusion.`
        const store = journal()
        const guard = createPublicTextGuard({ details, store, now: () => new Date(), log: () => {} })
        const sent = await publicBody(guard, { repository: 'harlan-zw/example', itemNumber: 24, writer }, writer === 'review' ? encodeEntities(input) : input).send(async body => body)

        expect(sent).toBe(`Public introduction.\n\n${removed}\n${removed}\n${removed}\n\nPublic conclusion.`)
        expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail' })])
      }
    }
  })

  it.each<PublicTextWriter>(['automated review', 'automated triage', 'review comment', 'review', 'comment', 'issue', 'pull request description', 'release comment', 'GitHub release'])('removes joined filesystem arguments before sending a %s and records one Incident', async (writer) => {
    const store = journal()
    const fixtureDetails = privateDetailsFor({ home: '/home/fixture', storagePath: ':memory:', checkoutRoots: ['/home/fixture/pkg'], workerHomes: ['/home/worker'], serviceOrigins: [] })
    const diagnostics = [
      'cc -I/home/fixture/pkg/example/include input.c',
      'cc -L/home/fixture/pkg/example/lib input.c',
      'cc -isystem/home/fixture/pkg/example/include input.c',
      'cc -I/home/fixture/public/../pkg/example/include input.c',
      'cc -I~/pkg/example/include input.c',
      'cc -I$HOME/pkg/example/include input.c',
      `cc -I\${HOME}/pkg/example/include input.c`,
      'cc -I~fixture/pkg/example/include input.c',
      'cc -I/home/worker/cache input.c',
      'cc -I%2Fhome%2Ffixture%2Fpkg/example/include input.c',
      'CFLAGS=-I/home/fixture/pkg/example/include make',
      'cc -Wp,-I/home/fixture/pkg/example/include input.c',
      'cc -Wl,-rpath,/home/fixture/pkg/example/lib input.c',
      'export LD_LIBRARY_PATH=/opt/lib:/home/fixture/pkg/example/lib',
    ]
    const finding: ReviewFinding = {
      _tag: 'Logged',
      impact: 42,
      summary: 'Compiler diagnostic',
      nextAction: 'Check the include path.',
      details: { fingerprint: 'e'.repeat(64), identity: diagnostics[0]!, location: { path: 'src/a.c', line: 3 }, proof: 'Compilation failed.' },
    }
    const diagnostic = diagnostics.join('\n')
    const input = `${writer === 'review' ? encodeEntities(diagnostic) : diagnostic}\n${reviewFindingThreadBody(finding, { headSha: reviewHead, repairOnHead: true })}`
    const sent = await publicBody(createPublicTextGuard({ details: fixtureDetails, store, now: () => new Date(), log: () => {} }), { repository: 'harlan-zw/example', itemNumber: 24, writer }, input).send(async body => body)

    expect(sent.split('\n').slice(0, diagnostics.length)).toEqual(diagnostics.map(() => removed))
    expect(sent).not.toContain('/home/')
    expect(reviewFindingThreadMarker(sent)).toMatchObject({ fingerprint: finding.details.fingerprint, identity: null })
    expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail', occurrences: 1 })])
  })

  it.each([
    'cc -I/usr/include input.c',
    'Read https://example.com/-I/home/fixture/pkg/include for the syntax.',
    'Read https://example.com/-I/home/fixture/public/../pkg/include for the syntax.',
    'cc -I/home/fixture/pkg-other/include input.c',
  ])('keeps public joined argument examples: %s', (input) => {
    expect(redactPrivateDetails(input, { paths: ['/home/fixture/pkg'], hosts: [] })).toEqual({ text: input, hits: [] })
  })

  it.each(['~/.codex/private-session.json', '$HOME/.codex/private-session.json', `\${HOME}/.codex/private-session.json`, '~agent/.codex/private-session.json'])('records an Incident when the only private detail is %s', async (path) => {
    const store = journal()
    const guard = createPublicTextGuard({ details, store, now: () => new Date(), log: () => {} })

    const sent = await publicBody(guard, { repository: 'harlan-zw/example', itemNumber: 24, writer: 'comment' }, `Failed to read ${path}`).send(async body => body)

    expect(sent).toBe(removed)
    expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail' })])
  })

  it.each<PublicTextWriter>(['automated review', 'automated triage', 'review comment', 'review', 'comment', 'issue', 'pull request description', 'release comment', 'GitHub release'])('redacts worker-home aliases and records an Incident for %s', async (writer) => {
    const store = journal()
    const paths = ['/home/agent/.codex/private-session.json', '~/.codex/private-session.json', '$HOME/.codex/private-session.json', `\${HOME}/.codex/private-session.json`, '~agent/.codex/private-session.json']
    const example = 'Example: /home/harlan/.config/example/config.json'
    const finding: ReviewFinding = {
      _tag: 'Logged',
      impact: 42,
      summary: 'Worker diagnostic',
      nextAction: 'Check the diagnostic.',
      details: { fingerprint: 'd'.repeat(64), identity: paths[1]!, location: { path: 'src/cache.ts', line: 3 }, proof: 'Worker diagnostic.' },
    }
    const diagnostic = [...paths.map(path => `Failed to read ${path}`), example].join('\n')
    const input = `${reviewFindingThreadBody(finding, { headSha: reviewHead, repairOnHead: true })}\n${writer === 'review' ? encodeEntities(diagnostic) : diagnostic}`
    const sent = await publicBody(createPublicTextGuard({ details, store, now: () => new Date(), log: () => {} }), { repository: 'harlan-zw/example', itemNumber: 24, writer }, input).send(async body => body)

    expect(sent).toContain([...paths.map(() => removed), example].join('\n'))
    expect(sent).not.toContain('private-session')
    expect(reviewFindingThreadMarker(sent)).toMatchObject({ fingerprint: finding.details.fingerprint, identity: null })
    expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail' })])
  })

  it.each<PublicTextWriter>(['automated review', 'automated triage', 'review comment', 'review', 'comment', 'issue', 'pull request description', 'release comment', 'GitHub release'])('guards encoded finding identities and parent paths for %s', async (writer) => {
    const store = journal()
    const finding: ReviewFinding = {
      _tag: 'Logged',
      impact: 42,
      summary: 'The cache leaks',
      nextAction: 'Reset the cache.',
      details: { fingerprint: 'c'.repeat(64), identity: '/home/harlan/public/../notes/private-evidence.md', location: { path: 'src/cache.ts', line: 3 }, proof: 'Two tests share one cache.' },
    }
    const source = reviewFindingThreadBody(finding, { headSha: reviewHead, repairOnHead: true })
    const diagnostic = 'Failed to read /home/harlan/public/../notes/private-evidence.md'
    const input = `${source}\n${writer === 'review' ? encodeEntities(diagnostic) : diagnostic}`
    const sent = await publicBody(createPublicTextGuard({ details, store, now: () => new Date(), log: () => {} }), { repository: 'harlan-zw/example', itemNumber: 24, writer }, input).send(async body => body)

    expect(reviewFindingThreadMarker(sent)).toMatchObject({ fingerprint: finding.details.fingerprint, identity: null })
    expect(sent).not.toContain('private-evidence')
    expect(sent).toContain(removed)
    expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail' })])
    expect(isPublishedForm(sent, input)).toBe(true)
  })

  it.each([
    ['create', true],
    ['update', true],
    ['create', false],
    ['update', false],
  ] as const)('guards a private title with a public body on %s, accepted: %s', async (operation, accepted) => {
    const store = journal()
    const sent: Array<{ title: string, body: string }> = []
    const write = async (input: { title: string, body: string }) => {
      sent.push({ title: input.title, body: input.body })
      if (!accepted)
        throw new Error('Fixture refuses the write.')
      return { data: { number: 24, html_url: 'https://github.com/harlan-zw/example/issues/24' } }
    }
    const publisher = createGitHubIssuePublisher({
      createClient: () => ({ rest: { issues: { create: write, update: write } } }) as unknown as Octokit,
      publicText: createPublicTextGuard({ log: () => {}, details, store, now: () => new Date('2026-11-22T06:05:00.000Z') }),
      tokens: { getToken: async () => ok({ token: 'fixture-token', expiresAt: '2099-01-01T00:00:00.000Z' }), invalidate: () => undefined },
    })
    const input = { repository: repositoryMapping(), title: 'See https://%6eotes%2elocalhost:443', body: 'Public evidence.' }

    const result = operation === 'create' ? await publisher.createIssue(input) : await publisher.updateIssue({ ...input, issueNumber: 24 })

    expect(result._tag).toBe(accepted ? 'Ok' : 'Err')
    expect(sent).toEqual([{ title: removed, body: input.body }])
    expect(store.listIncidents()).toEqual(accepted
      ? [expect.objectContaining({ kind: 'private_detail', occurrences: 1, message: expect.stringContaining('notes.localhost') })]
      : [])
  })

  it.each([
    '[reference](https://%70rivate%2eexample:443)',
    '[reference](//%70rivate%2eexample:8443)',
    '[reference](https://user:password@%70rivate%2eexample:443)',
    '[reference](https://private。example:443)',
    '[reference](https://%70rivate%2eexample:443 "title")',
    '[reference](<https://%70rivate%2eexample:443>)',
    '[reference]: https://%70rivate%2eexample:443',
  ])('removes encoded hosts with ports through a publisher: %s', async (input) => {
    const store = journal()
    const sent: string[] = []
    const publisher = createGitHubIssuePublisher({
      createClient: () => ({ rest: { issues: { createComment: async (request: { body: string }) => {
        sent.push(request.body)
        return { data: { id: 7 } }
      } } } }) as unknown as Octokit,
      publicText: createPublicTextGuard({ log: () => {}, details: { paths: [], hosts: ['private.example'] }, store, now: () => new Date('2026-11-22T06:05:00.000Z') }),
      tokens: { getToken: async () => ok({ token: 'fixture-token', expiresAt: '2099-01-01T00:00:00.000Z' }), invalidate: () => undefined },
    })
    const publicLine = '[public](https://example.com:443/%70rivate%2eexample)'

    expect(await publisher.createComment({ repository: repositoryMapping(), issueNumber: 24, body: `${input}\n${publicLine}` })).toEqual(ok({ id: 7 }))
    expect(sent).toEqual([`${removed}\n${publicLine}`])
    expect(store.listIncidents()).toEqual([expect.objectContaining({ message: expect.stringContaining('private.example') })])
  })

  it.each(['create', 'update'] as const)('guards a Candidate claim in both title and body on issue %s', async (operation) => {
    const store = journal()
    const sent: Array<{ title: string, body: string }> = []
    const write = async (input: { title: string, body: string }) => {
      sent.push({ title: input.title, body: input.body })
      return { data: { number: 24, html_url: 'https://github.com/harlan-zw/example/issues/24' } }
    }
    const publisher = createGitHubIssuePublisher({
      createClient: () => ({ rest: { issues: { create: write, update: write } } }) as unknown as Octokit,
      publicText: createPublicTextGuard({ log: () => {}, details, store, now: () => new Date('2026-11-22T06:05:00.000Z') }),
      tokens: { getToken: async () => ok({ token: 'fixture-token', expiresAt: '2099-01-01T00:00:00.000Z' }), invalidate: () => undefined },
    })
    const candidate = {
      id: 'candidate-1',
      routineId: 'routine-1',
      runId: 'run-1',
      fingerprint: 'fixture',
      title: ' ',
      claim: 'Read ~/.codex/private-evidence.md',
      target: 'src/cache.ts',
      verification: 'pnpm test',
      estimatedChangedFiles: 1,
      result: { _tag: 'Proposed', pullRequest: null } as const,
      createdAt: '2026-11-22T06:05:00.000Z',
      updatedAt: '2026-11-22T06:05:00.000Z',
    }
    const input = {
      repository: repositoryMapping(),
      title: candidateIssueTitle(candidate),
      body: candidateIssueBody(candidate, { repository: 'harlan-zw/example', name: 'pr-triage', scheduledFor: '2026-11-22T06:00:00.000Z' }),
    }

    const result = operation === 'create' ? await publisher.createIssue(input) : await publisher.updateIssue({ ...input, issueNumber: 24 })

    expect(result._tag).toBe('Ok')
    expect(sent).toEqual([{
      title: removed,
      body: input.body.replace(candidate.claim, removed),
    }])
    expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail', occurrences: 1 })])
  })

  it.each<PublicTextWriter>(['automated review', 'automated triage', 'review comment', 'review', 'comment', 'issue', 'pull request description', 'release comment', 'GitHub release'])('removes normalized Markdown hosts before sending a %s', async (writer) => {
    const privateLines = [
      String.raw`[evidence](https://notes\.localhost/fixture.md)`,
      String.raw`[evidence](//notes\.localhost/fixture.md)`,
      String.raw`[ref]: <https://sub.notes\.localhost/fixture.md>`,
      '_notes.localhost_',
      '__harlan-github-agent.localhost__',
      '___hogwild.tail1234.ts.net___',
      '[evidence](https://%6eotes%2elocalhost/fixture.md)',
      '[evidence](https://%6eotes%2elocalhost:443)',
      '[evidence](//%6eotes%2elocalhost:8443)',
      '[evidence](https://notes。localhost/fixture.md)',
      String.raw`[evidence](https://fixture-user:fixture-password@notes\.localhost/fixture.md)`,
      String.raw`<!-- evidence: https://notes\.localhost/fixture.md -->`,
    ]
    const publicLines = [
      String.raw`[public](https://example.com/notes\.localhost/fixture.md)`,
      String.raw`[public](https://notes\.localhost.example.com/fixture.md)`,
      '[public](https://%6eotes%2elocalhost.example.com:443)',
      '[public](https://example.com:443/%6eotes%2elocalhost)',
      '_notes.localhost.example.com_',
    ]
    const input = [...privateLines, ...publicLines].join('\n')
    const sent: string[] = []

    await publicBody({ details, report: () => {} }, { repository: 'harlan-zw/example', itemNumber: 24, writer }, input).send(async (body) => {
      sent.push(body)
    })

    expect(sent).toEqual([[...privateLines.map(() => removed), ...publicLines].join('\n')])
  })

  it.each([
    '<a href="https://notes.localhost/\nacquisition.pdf">evidence</a>',
    '/home/har<span title="&quot; > context\nmore context"></span>lan/notes/acquisition.pdf',
    '__~/notes/fixture.md__',
    '_$HOME/scratch/fixture.log_',
    '__/home/agent/fixture.log__',
    '__~/notes__',
    '_~/scratch_',
  ])('removes an underscore-emphasized path before publishing an issue comment: %s', async (input) => {
    const store = journal()
    const sent: string[] = []
    const publisher = createGitHubIssuePublisher({
      createClient: () => ({ rest: { issues: { createComment: async (request: { body: string }) => {
        sent.push(request.body)
        return { data: { id: 7 } }
      } } } }) as unknown as Octokit,
      publicText: createPublicTextGuard({ log: () => {}, details, store, now: () => new Date('2026-11-22T06:05:00.000Z') }),
      tokens: { getToken: async () => ok({ token: 'fixture-token', expiresAt: '2099-01-01T00:00:00.000Z' }), invalidate: () => undefined },
    })

    expect(await publisher.createComment({ repository: repositoryMapping(), issueNumber: 24, body: input })).toEqual(ok({ id: 7 }))

    expect(sent).toEqual([input.split('\n').map(() => removed).join('\n')])
    expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail' })])
  })

  it.each(['&#46;', '&#0000046;', '&#x2e;', '&#X2E;', '&period;'])('removes an entity-encoded private destination before publishing an issue comment: %s', async (dot) => {
    const store = journal()
    const sent: string[] = []
    const publisher = createGitHubIssuePublisher({
      createClient: () => ({ rest: { issues: { createComment: async (request: { body: string }) => {
        sent.push(request.body)
        return { data: { id: 7 } }
      } } } }) as unknown as Octokit,
      publicText: createPublicTextGuard({ log: () => {}, details, store, now: () => new Date('2026-11-22T06:05:00.000Z') }),
      tokens: { getToken: async () => ok({ token: 'fixture-token', expiresAt: '2099-01-01T00:00:00.000Z' }), invalidate: () => undefined },
    })

    expect(await publisher.createComment({ repository: repositoryMapping(), issueNumber: 24, body: `Read [evidence](https://notes${dot}localhost/fixture.md) now.` })).toEqual(ok({ id: 7 }))

    expect(sent).toEqual([removed])
    expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail' })])
  })

  it.each<PublicTextWriter>(['automated review', 'automated triage', 'review comment', 'review', 'comment', 'issue', 'pull request description', 'release comment', 'GitHub release'])('protects emphasized paths and encoded hosts for %s while preserving public siblings', async (writer) => {
    const input = [
      '__~/notes/fixture.md__',
      '[evidence](https://notes&#46;localhost/fixture.md)',
      'Public text &amp; punctuation stays.',
      '__/home/harlan/notes_old/fixture.md__',
      '_/home/agent_old/fixture.log_',
      '[public](https://example.com/notes&#46;localhost/fixture.md)',
      '[public](https://notes&#46;localhost.example.com/fixture.md)',
    ]
    const sent: string[] = []

    await publicBody({ details, report: () => {} }, { repository: 'harlan-zw/example', itemNumber: 24, writer }, input.join('\n')).send(async (body) => {
      sent.push(body)
    })

    expect(sent).toEqual([[removed, removed, ...input.slice(2)].join('\n')])
  })

  it.each<PublicTextWriter>(['automated review', 'automated triage', 'review comment', 'review', 'comment', 'issue', 'pull request description', 'release comment', 'GitHub release'])('removes the whole line around a parenthesized private URL before sending a %s', async (writer) => {
    for (const destination of [
      'https://notes.localhost/reports/quarterly(final)/appendix.pdf',
      '<https://notes.localhost/reports/quarterly(final)/appendix.pdf>',
      'https://notes.localhost/reports/quarterly(a(b)c)',
      '<https://notes.localhost/reports/quarterly(final)>',
      '(https://notes.localhost/reports/quarterly(final)/appendix.pdf)',
    ]) {
      const input = `Read ${destination}. Public text survives.`
      const source = writer === 'review' ? encodeEntities(input) : input
      const sent: string[] = []
      await publicBody({ details, report: () => {} }, { repository: 'harlan-zw/example', itemNumber: 24, writer }, source).send(async (body) => {
        sent.push(body)
      })
      expect(sent).toEqual([removed])
    }
  })

  it.each(['', ' (public context)'])('keeps the lines after an unclosed private link%s', async (suffix) => {
    const input = `[notes](https://notes.localhost/reports/quarterly(final)/appendix.pdf\nPublic text${suffix}.\n\n\`\`\`\n- [ ] Add this draft to the GitHub release`
    const sent: string[] = []
    await publicBody({ details, report: () => {} }, { repository: 'harlan-zw/example', itemNumber: 24, writer: 'release comment' }, input).send(async (body) => {
      sent.push(body)
    })
    expect(sent).toEqual([input.replace('[notes](https://notes.localhost/reports/quarterly(final)/appendix.pdf', removed)])
  })

  it.each<PublicTextWriter>([
    'automated review',
    'automated triage',
    'review comment',
    'review',
    'comment',
    'issue',
    'pull request description',
    'release comment',
    'GitHub release',
  ])('removes the whole line before sending a %s', async (writer) => {
    const input = 'Read [notes](https://fixture-user:fixture-password@notes.localhost/docs/acquisition(final)/internal.pdf). See `~/notes/acquisition(final)[internal].pdf`.'
    const sent: string[] = []
    await publicBody({ details, report: () => {} }, { repository: 'harlan-zw/example', itemNumber: 24, writer }, writer === 'review' ? encodeEntities(input) : input)
      .send(async (body) => {
        sent.push(body)
      })

    expect(sent).toEqual([removed])
  })

  it('records no Incident for a write GitHub rejects', async () => {
    const store = journal()
    const guard = createPublicTextGuard({ log: () => {}, details, store, now: () => new Date('2026-11-22T06:05:00.000Z') })

    await expect(publicBody(guard, { repository: 'harlan-zw/example', itemNumber: 24, writer: 'review comment' }, 'See ~/notes/a.md.')
      .send(() => Promise.reject(new Error('Validation Failed')))).rejects.toThrow('Validation Failed')
    expect(store.listIncidents()).toEqual([])
  })

  it('removes every spelling of a checkout root before GitHub receives a comment, and records an Incident', async () => {
    const store = journal()
    const sent: string[] = []
    const publisher = createGitHubIssuePublisher({
      createClient: () => ({ rest: { issues: { createComment: async (input: { body: string }) => {
        sent.push(input.body)
        return { data: { id: 7 } }
      } } } }) as unknown as Octokit,
      publicText: createPublicTextGuard({ log: () => {}, details, store, now: () => new Date('2026-11-22T06:05:00.000Z') }),
      tokens: { getToken: async () => ok({ token: 'fixture-token', expiresAt: '2099-01-01T00:00:00.000Z' }), invalidate: () => undefined },
    })
    const paths = [...['pkg', 'sites'].flatMap(root => ['/home/harlan', '~', '$HOME'].map(home => `${home}/${root}/example-worktree`)), '~/.codex/private-session.json', '$HOME/.codex/private-session.json']

    expect(await publisher.createComment({ repository: repositoryMapping({ github: 'harlan-zw/harlan-agent-kit' }), issueNumber: 271, body: [...paths, '/home/harlan/.config'].join('\n') })).toEqual(ok({ id: 7 }))

    expect(sent).toEqual([[...paths.map(() => removed), '/home/harlan/.config'].join('\n')])
    expect(store.listIncidents()).toEqual([expect.objectContaining({
      scope: { _tag: 'Repository', repository: 'harlan-zw/harlan-agent-kit' },
      kind: 'private_detail',
      recovery: { _tag: 'ActionRequired' },
      message: expect.stringContaining('harlan-zw/harlan-agent-kit#271'),
    })])
  })

  it('cleans a canonical comment GitHub already holds with a leak, and confirms the edit', async () => {
    const store = journal()
    const leaked = reviewBody('Notes: ~/notes/review-24.md', 'REVIEWING')
    const host = commentHost([{ id: 5, body: leaked }])

    const result = await agentSource(host.client, store).editReviewStatus(repositoryMapping(), 24, 5, leaked, reviewBody('Notes: ~/notes/review-24.md', 'STOPPED'), new AbortController().signal)

    expect(result).toEqual(ok(expect.objectContaining({ _tag: 'Edited', commentId: 5 })))
    expect(host.comments[0]?.body).toBe(reviewBody(removed, 'STOPPED'))
    expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail', message: expect.stringContaining('harlan-zw/example#24') })])
  })

  it('keeps editing a canonical comment after the deny list changes', async () => {
    const store = journal()
    const host = commentHost()
    const before = reviewBody('Dashboard: https://hogwild.tail1234.ts.net/items/24')
    const published = await agentSource(host.client, store).upsertReviewStatus(repositoryMapping(), 24, null, before, false, new AbortController().signal)
    if (published._tag === 'Err')
      throw new Error(published.error)
    const restarted = privateDetailsFor({ home: '/home/harlan', storagePath: ':memory:', checkoutRoots: [], workerHomes: [], serviceOrigins: ['https://other.tail1234.ts.net'] })

    const edited = await agentSource(host.client, store, restarted).editReviewStatus(repositoryMapping(), 24, published.value.commentId, before, reviewBody('Stopped.'), new AbortController().signal)

    expect(edited).toEqual(ok(expect.objectContaining({ _tag: 'Edited' })))
    expect(host.comments[0]?.body).toContain('Stopped.')
  })

  it('records one Incident for a body written once, and none for a refused write', async () => {
    const store = journal()
    const host = commentHost()
    const source = agentSource(host.client, store)
    const body = reviewBody('Notes: ~/notes/review-24.md')

    expect(await source.upsertReviewStatus(repositoryMapping(), 24, null, body, false, new AbortController().signal, () => ok(undefined))).toEqual(ok(expect.anything()))
    expect(await source.upsertReviewStatus(repositoryMapping(), 24, null, body, false, new AbortController().signal, () => ok(undefined))).toEqual(ok(expect.anything()))
    expect(host.writes).toHaveLength(1)
    expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail', occurrences: 1 })])

    const refused = journal()
    const refusedHost = commentHost()
    expect(await agentSource(refusedHost.client, refused).upsertReviewStatus(repositoryMapping(), 24, null, body, false, new AbortController().signal, () => ({ _tag: 'Err', error: 'Lease expired.' }))).toEqual({ _tag: 'Err', error: 'Lease expired.' })
    expect(refusedHost.writes).toHaveLength(0)
    expect(refused.listIncidents()).toEqual([])
  })

  it.each([
    '<a href="https://notes.localhost/\nacquisition.pdf">evidence</a>',
    '/home/har<span title="&quot; > context\nmore context"></span>lan/notes/acquisition.pdf',
    'The trace in ~/pkg/cache_trace/run.log shows two locales sharing one key.',
    'The cache at /srv/agent_home/cache is stale.',
    'The file `~/notes/client handover/a.pdf` is stale.',
    'The file `~/notes/acquisition(final)[internal].pdf` is stale.',
  ])('removes a native review line after its text was entity-encoded: %s', async (proof) => {
    const store = journal()
    const written: string[] = []
    const withEncodedRoot = privateDetailsFor({ home: '/home/harlan', storagePath: ':memory:', checkoutRoots: ['/home/harlan/pkg'], workerHomes: ['/srv/agent_home'], serviceOrigins: [] })
    const client = {
      paginate: async () => [],
      rest: { pulls: {
        listReviews: () => undefined,
        createReview: async (input: { commit_id: string, body: string }) => {
          written.push(input.body)
          return { data: { id: 1, user: { login: 'harlan-github-agent[bot]' }, state: 'COMMENTED', commit_id: input.commit_id, body: input.body } }
        },
      } },
    } as unknown as Octokit
    // The native review omits finding text, so supply encoded evidence at the writer boundary.
    const body = `${nativeReviewBody({
      headSha: reviewHead,
      outcome: 'READY',
      commentUrl: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
      findings: [],
    })}\n\n${encodeEntities(proof)}\n`

    expect(await agentSource(client, store, withEncodedRoot).upsertNativeReview(repositoryMapping(), 24, reviewHead, body, new AbortController().signal, () => ok(undefined))).toEqual(ok(undefined))
    expect(written[0]).toContain(`\n${removed}\n`)
    expectNoFragment(written[0]!)
    expect(written[0]).not.toContain('agent&#95;home')
    expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail', message: expect.stringContaining('the review on harlan-zw/example#24') })])
  })
})

/** One pull request whose comments live in memory, so a source can publish and read them back. */
function commentHost(initial: Array<{ id: number, body: string }> = []) {
  const comments = initial.map(comment => ({
    ...comment,
    author_association: 'NONE',
    html_url: `https://github.com/harlan-zw/example/pull/24#issuecomment-${comment.id}`,
    issue_url: 'https://api.github.com/repos/harlan-zw/example/issues/24',
    user: { login: 'harlan-github-agent[bot]' },
  }))
  const writes: string[] = []
  const write = (id: number | undefined, body: string) => {
    writes.push(body)
    const existing = comments.find(comment => comment.id === id)
    if (existing !== undefined) {
      existing.body = body
      return Promise.resolve({ data: existing })
    }
    const created = { id: 50 + comments.length, body, author_association: 'NONE', html_url: `https://github.com/harlan-zw/example/pull/24#issuecomment-${50 + comments.length}`, issue_url: 'https://api.github.com/repos/harlan-zw/example/issues/24', user: { login: 'harlan-github-agent[bot]' } }
    comments.push(created)
    return Promise.resolve({ data: created })
  }
  const client = {
    paginate: () => Promise.resolve(comments),
    rest: { issues: {
      listComments: () => undefined,
      getComment: (input: { comment_id: number }) => Promise.resolve({ data: comments.find(comment => comment.id === input.comment_id) }),
      createComment: (input: { body: string }) => write(undefined, input.body),
      updateComment: (input: { comment_id: number, body: string }) => write(input.comment_id, input.body),
    } },
  } as unknown as Octokit
  return { client, comments, writes }
}

function agentSource(client: Octokit, store: ReturnType<typeof journal>, sourceDetails = details) {
  return createGitHubAgentSource({
    actorLogin: () => 'harlan-github-agent[bot]',
    createClient: () => client,
    ownAppId: 98114,
    publicText: createPublicTextGuard({ log: () => {}, details: sourceDetails, store, now: () => new Date('2026-11-22T06:05:00.000Z') }),
    tokens: { getToken: async () => ok({ token: 'token', expiresAt: '2099-01-01T00:00:00.000Z' }), invalidate: () => undefined },
  })
}

const reviewHead = '1031dc93dddca88266cb32a085c7b90dcd58ec23'
function reviewBody(line: string, state = 'READY') {
  return `<!-- harlan-agent-kit:pr-triage -->
<!-- reviewed-sha: ${reviewHead} -->
### 🤖 ${state}

${line}`
}

describe('a review comment on a line', () => {
  it.each(['~/notes/private-evidence.md', '/home/harlan/public/../notes/private-evidence.md', 'https://notes.localhost/private-evidence', 'context\n~/notes/private-evidence.md', '/home/har<span title="&quot; > context\nmore context"></span>lan/notes/private-evidence.md'])('protects an identity on inline creation and later edits: %s', async (identity) => {
    const store = journal()
    const written: string[] = []
    const write = async (input: { body: string }) => {
      written.push(input.body)
      return { data: { id: 101, body: input.body } }
    }
    const client = { rest: { pulls: {
      createReviewComment: write,
      updateReviewComment: write,
      getReviewComment: async () => ({ data: { id: 101, body: written[0], user: { login: 'harlan-github-agent[bot]' } } }),
    } } } as unknown as Octokit
    const source = agentSource(client, store)
    const finding: ReviewFinding = {
      _tag: 'Logged',
      impact: 42,
      summary: 'The cache leaks',
      nextAction: 'Reset the cache.',
      details: { fingerprint: 'c'.repeat(64), identity, location: { path: 'src/cache.ts', line: 3 }, proof: 'Two tests share one cache.' },
    }
    const body = reviewFindingThreadBody(finding, { headSha: reviewHead, repairOnHead: true })
    const signal = new AbortController().signal

    expect(await source.postReviewFindingComment(repositoryMapping(), 24, { headSha: reviewHead, path: 'src/cache.ts', line: 3, body }, signal, () => ok(undefined))).toEqual(ok(expect.objectContaining({ _tag: 'Posted' })))
    expect(await source.editReviewFindingComment!(repositoryMapping(), { id: 101, body: written[0]! }, `${body}\nPublic update.`, signal, () => ok(undefined), 24)).toEqual(ok(expect.objectContaining({ id: 101 })))

    expect(written).toHaveLength(2)
    for (const sent of written) {
      expect(reviewFindingThreadMarker(sent)).toMatchObject({ fingerprint: finding.details.fingerprint, identity: null, logged: true })
      expect(sent).not.toContain('private-evidence')
      expect(sent).not.toContain(identity)
    }
    expect(written[1]).toContain('Public update.')
    expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail', occurrences: 1 })])
  })

  it('preserves a public identity and does not report a private detail', () => {
    const finding: ReviewFinding = {
      _tag: 'Logged',
      impact: 42,
      summary: 'The cache leaks',
      nextAction: 'Reset the cache.',
      details: { fingerprint: 'c'.repeat(64), identity: 'cache-leak', location: { path: 'src/cache.ts', line: 3 }, proof: 'Two tests share one cache.' },
    }
    const body = reviewFindingThreadBody(finding)

    expect(redactPrivateDetails(body, details)).toEqual({ text: body, hits: [] })
    expect(reviewFindingThreadMarker(body)?.identity).toBe('cache-leak')
  })

  it('stays the Service thread for its finding after its heading line was removed', async () => {
    const guard = { details, report: () => {} }
    const threads: ReviewFindingThread[] = []
    const posted: string[] = []
    const reports: ReviewFindingThreadsOutcome[] = []
    const mirror: ReviewFindingThreadMirror = {
      source: {
        listReviewFindingThreads: async () => ok(threads),
        postReviewFindingComment: async (_repository, _number, comment) => {
          const body = await publicBody(guard, { repository: 'harlan-zw/example', itemNumber: 24, writer: 'review comment' }, comment.body).send(async sent => sent)
          posted.push(body)
          const fingerprint = reviewFindingThreadFingerprint(body)
          if (fingerprint !== null)
            threads.push({ threadId: `thread-${threads.length}`, fingerprint, resolved: false, comment: { id: 100 + threads.length, body } })
          return ok({ _tag: 'Posted', comment: { id: 100 + threads.length, body } })
        },
        editReviewFindingComment: async (_repository, comment, bodyText) => {
          const body = publicBody(guard, { repository: 'harlan-zw/example', itemNumber: 24, writer: 'review comment' }, bodyText).text
          return ok({ ...comment, body })
        },
        resolveReviewFindingThread: async () => ok(undefined),
      },
      report: (_repository, outcome) => reports.push(outcome),
    }
    const finding: ReviewFinding = {
      _tag: 'Logged',
      impact: 42,
      summary: 'The cache at ~/pkg/example/cache leaks between tests',
      nextAction: 'Reset the cache.',
      details: { fingerprint: 'c'.repeat(64), identity: 'cache-leak', location: { path: 'src/cache.ts', line: 3 }, proof: 'Two tests share one cache.' },
    }

    for (let pass = 0; pass < 2; pass++)
      await mirrorReviewFindingThreads(mirror, repositoryMapping(), 24, reviewHead, [finding], new AbortController().signal, () => ok(undefined), 'open', { controls: { repairOnHead: true } })

    expect(posted).toHaveLength(1)
    expect(posted[0]).toContain(removed)
    expectNoFragment(posted[0]!)
    expect(reports.every(outcome => outcome._tag === 'Written')).toBe(true)
  })
})

describe('ported from the Service Repair 0b4efc07', () => {
  it('keeps a repeated line removed in a MERGED edit after the dashboard hostname changes', async () => {
    const store = journal()
    const host = commentHost()
    const action = 'Read https://hogwild.tail1234.ts.net/items/24/private-evidence for the next action.'
    const before = reviewBody(action)
    const published = await agentSource(host.client, store).upsertReviewStatus(repositoryMapping(), 24, null, before, false, new AbortController().signal)
    if (published._tag === 'Err')
      throw new Error(published.error)
    expect(host.comments[0]?.body).toBe(reviewBody(removed))
    const restarted = { paths: [], hosts: ['other.tail1234.ts.net'] }

    const edited = await agentSource(host.client, store, restarted).editReviewStatus(repositoryMapping(), 24, published.value.commentId, before, reviewBody(`MERGED\n\n${action}\n${action}`), new AbortController().signal)

    expect(edited).toEqual(ok(expect.objectContaining({ _tag: 'Edited' })))
    expect(host.comments[0]?.body).toBe(reviewBody(`MERGED\n\n${removed}\n${removed}`))
  })

  it.each([
    'Read https://fixture-user:fixture\'password@notes.localhost/report.md first.',
    '\'https://fixture-user:fixture\'password@notes.localhost\'',
    'https://fixture-user:fixture(password)@notes.localhost/report.md',
    'https://fixture-user:fixture;password@notes.localhost/report.md',
    'Read [notes]( https://notes.localhost/docs/report(final)/draft.pdf) first.',
    'Read [notes](\thttps://notes.localhost/docs/report(final)/draft.pdf) first.',
  ])('removes the whole line around unusual URL syntax: %s', (input) => {
    expect(redactPrivateDetails(input, details).text).toBe(removed)
    expect(redactPrivateDetails(encodeEntities(input), details).text).toBe(removed)
  })
})

describe('review findings on #754, fourth round', () => {
  it('keeps a removed line removed when an inline review comment is rebuilt after the deny list changes', async () => {
    const store = journal()
    const written: string[] = []
    const source = privateDetailsFor({ home: '/home/harlan', storagePath: ':memory:', checkoutRoots: [], workerHomes: [], serviceOrigins: ['https://hogwild.tail1234.ts.net'] })
    const restarted = privateDetailsFor({ home: '/home/harlan', storagePath: ':memory:', checkoutRoots: [], workerHomes: [], serviceOrigins: ['https://other.tail1234.ts.net'] })
    const thread = '<!-- harlan-agent-kit:pr-triage -->\n**Minor (40/100): The cache leaks**\n\nSee https://hogwild.tail1234.ts.net/items/24 for the trace.\n\nReset the cache.'
    const published = publicBody({ details: source, report: () => {} }, { repository: 'harlan-zw/example', itemNumber: 24, writer: 'review comment' }, thread).text
    const client = {
      rest: { pulls: {
        getReviewComment: async () => ({ data: { id: 101, body: published, user: { login: 'harlan-github-agent[bot]' } } }),
        updateReviewComment: async (input: { body: string }) => {
          written.push(input.body)
          return { data: { id: 101, body: input.body } }
        },
      } },
    } as unknown as Octokit

    await agentSource(client, store, restarted).editReviewFindingComment!(repositoryMapping(), { id: 101, body: published }, `${thread}\n\n✅ Addressed in commit [abc1234](https://github.com/harlan-zw/example/commit/abc1234)`, new AbortController().signal, () => ok(undefined), 24)

    expect(written).toHaveLength(1)
    expect(written[0]).toContain(removed)
    expectNoFragment(written[0]!)
  })

  it.each([
    'Open **https://harlan-github-agent.localhost** now.',
    'Open **https://harlan-github-agent.localhost/tasks/1** now.',
    'Open __https://notes.localhost__ now.',
    'Open ``~/notes/a`b(1).md`` now.',
  ])('removes a line with emphasis or a double-backtick span: %s', (line) => {
    expect(redactPrivateDetails(line, details).text).toBe(removed)
  })

  it('protects a dedicated top-level worker home, and never a system directory', () => {
    const topLevel = privateDetailsFor({ home: '/home/harlan', storagePath: ':memory:', checkoutRoots: [], workerHomes: ['/worker-data', '/home', '/tmp'], serviceOrigins: [] })

    expect(redactPrivateDetails('Cache at /worker-data/cache.', topLevel).text).toBe(removed)
    expect(redactPrivateDetails('Files in /home/other and /tmp/x stay.', topLevel).text).toBe('Files in /home/other and /tmp/x stay.')
  })
})

describe('ported from the Service Repair 73c25d86', () => {
  it.each(['**', '__', '*', '_'])('removes a private host-only URL inside %s emphasis', (delimiter) => {
    const input = `${delimiter}https://hogwild.tail1234.ts.net${delimiter}`
    expect(redactPrivateDetails(input, details).text).toBe(removed)
    expect(redactPrivateDetails(encodeEntities(input), details).text).toBe(removed)
  })

  it('can edit a canonical comment after removing a multiline destination', async () => {
    const store = journal()
    const host = commentHost()
    const link = 'Read [evidence](\nhttps://hogwild.tail1234.ts.net/docs/report(final)/private.pdf\n).'
    const before = reviewBody(link)
    const published = await agentSource(host.client, store).upsertReviewStatus(repositoryMapping(), 24, null, before, false, new AbortController().signal)
    if (published._tag === 'Err')
      throw new Error(published.error)

    const edited = await agentSource(host.client, store).editReviewStatus(repositoryMapping(), 24, published.value.commentId, before, reviewBody(`MERGED\n\n${link}`), new AbortController().signal)

    expect(edited).toEqual(ok(expect.objectContaining({ _tag: 'Edited' })))
    expect(host.comments[0]?.body).toBe(reviewBody(`MERGED\n\n${removed}\n${removed}\n${removed}`))
  })

  it.each<PublicTextWriter>(['automated review', 'automated triage', 'review comment', 'review', 'comment', 'issue', 'pull request description', 'release comment', 'GitHub release'])('keeps protected details after a Journal restart for %s', async (writer) => {
    const directory = mkdtempSync(join(tmpdir(), 'private-details-'))
    const path = join(directory, 'journal.sqlite')
    const first = openJournalStore(path)
    createPublicTextGuard({ log: () => {}, details, store: first, now: () => new Date() })
    first.close()
    const second = openJournalStore(path)
    try {
      const guard = createPublicTextGuard({ log: () => {}, details: { paths: [], hosts: ['other.example'] }, store: second, now: () => new Date() })
      const sent: string[] = []
      await publicBody(guard, { repository: 'harlan-zw/example', itemNumber: 24, writer }, 'https://hogwild.tail1234.ts.net/evidence\n~/notes/private.pdf').send(async (body) => {
        sent.push(body)
      })
      expect(sent).toEqual([`${removed}\n${removed}`])
    }
    finally {
      second.close()
      rmSync(directory, { recursive: true })
    }
  })

  it('keeps a Logged finding private when the same finding syncs after a hostname change', async () => {
    const store = journal()
    let comment = { id: 51, body: '' }
    const client = { rest: { pulls: {
      createReviewComment: async (input: { body: string }) => {
        comment = { id: 51, body: input.body }
        return { data: comment }
      },
      getReviewComment: async () => ({ data: { ...comment, user: { login: 'harlan-github-agent[bot]' } } }),
      updateReviewComment: async (input: { body: string }) => {
        comment = { ...comment, body: input.body }
        return { data: comment }
      },
    } } } as unknown as Octokit
    const finding = { _tag: 'Logged' as const, impact: 40, summary: 'Evidence needs attention.', nextAction: 'Read the evidence.', details: { fingerprint: 'f'.repeat(64), identity: 'private-evidence', location: { path: 'src/a.ts', line: 3 }, proof: 'Read [evidence](https://hogwild.tail1234.ts.net/evidence).' } }
    await agentSource(client, store).postReviewFindingComment(repositoryMapping(), 24, { headSha: reviewHead, path: 'src/a.ts', line: 3, body: reviewFindingThreadBody(finding) }, new AbortController().signal, () => ok(undefined))
    expect(comment.body).toContain(removed)
    const restarted = agentSource(client, store, { paths: [], hosts: ['other.example'] })

    const result = await mirrorReviewFindingThreads({ source: { ...restarted, listReviewFindingThreads: async () => ok([{ threadId: 'thread', fingerprint: finding.details.fingerprint, resolved: false, comment }]) }, report: () => {} }, repositoryMapping(), 24, reviewHead, [finding], new AbortController().signal, () => ok(undefined))

    expect(result._tag).toBe('Written')
    expect(comment.body).toContain(removed)
    expect(comment.body).not.toContain('hogwild.tail1234.ts.net')
  })

  it('keeps a destination private when a canonical edit removes Markdown formatting', async () => {
    const store = journal()
    const host = commentHost()
    const url = 'https://hogwild.tail1234.ts.net/evidence'
    const before = reviewBody(`Read [evidence](${url}).`)
    const published = await agentSource(host.client, store).upsertReviewStatus(repositoryMapping(), 24, null, before, false, new AbortController().signal)
    if (published._tag === 'Err')
      throw new Error(published.error)

    const edited = await agentSource(host.client, store, { paths: [], hosts: ['other.example'] }).editReviewStatus(repositoryMapping(), 24, published.value.commentId, before, reviewBody(`MERGED\n\nRead ${url}.`), new AbortController().signal)

    expect(edited).toEqual(ok(expect.objectContaining({ _tag: 'Edited' })))
    expect(host.comments[0]?.body).toBe(reviewBody(`MERGED\n\n${removed}`))
  })

  it.each<PublicTextWriter>(['automated review', 'automated triage', 'review comment', 'review', 'comment', 'issue', 'pull request description', 'release comment', 'GitHub release'])('removes emphasized and multiline destinations at the %s boundary', async (writer) => {
    const input = '**https://hogwild.tail1234.ts.net** Read [evidence](\nhttps://hogwild.tail1234.ts.net/docs/report(final)/private.pdf\n).'
    const sent: string[] = []
    await publicBody({ details, report: () => {} }, { repository: 'harlan-zw/example', itemNumber: 24, writer }, writer === 'review' ? encodeEntities(input) : input).send(async (body) => {
      sent.push(body)
    })
    expect(sent).toEqual([`${removed}\n${removed}\n${removed}`])
  })
})

describe('spellings GitHub renders, review findings on #754, final round', () => {
  it.each([
    ['emphasis inside a path', 'Open ~/**notes**/fixture.md now.'],
    ['underscore emphasis around a path', 'Open __~/notes/fixture.md__ now.'],
    ['a bold path', 'Open **~/notes/fixture.md** now.'],
    ['strikethrough around a path', 'Open ~~~/notes/fixture.md~~ now.'],
    ['an inline tag inside a path', 'Open ~/<b>notes</b>/fixture.md now.'],
    ['backticks inside a path', 'Open ~/`notes`/fixture.md now.'],
    ['an entity-encoded host in a link destination', 'Read [notes](https://notes&#46;localhost/report.md) now.'],
    ['a named entity in a host', 'Read https://notes&period;localhost/report.md now.'],
    ['a hex entity in a path', 'Open &#x7E;/notes/fixture.md now.'],
    ['a named entity slash in a path', 'Open &sol;home&sol;agent&sol;cache now.'],
    ['a percent-encoded path', 'Open %7E/notes/fixture.md now.'],
    ['a percent-encoded slash in a path', 'Open %2Fhome%2Fagent%2Fcache now.'],
    ['a percent-encoded host', 'Read https://notes%2Elocalhost/report.md now.'],
    ['a zero-width character inside a host', 'Read https://notes\u200B.localhost/report.md now.'],
    ['an encoded zero-width character inside a host', 'Read https://notes&#8203;.localhost/report.md now.'],
    ['a backslash escape inside a path', 'Open \\~/notes\\/fixture.md now.'],
    // The braced variable is the spelling under test, not a template.
    // eslint-disable-next-line no-template-curly-in-string
    ['a braced home variable', 'Open ${HOME}/scratch/run.log now.'],
    ['a tilde with the user name', 'Open ~harlan/scratch/run.log now.'],
    ['an upper-case host', 'Read https://NOTES.LOCALHOST/report.md now.'],
  ])('removes the line for %s', (_name, line) => {
    const redacted = redactPrivateDetails(line, details)

    expect(redacted.text).toBe(removed)
    expect(redacted.hits).not.toHaveLength(0)
  })

  it.each([
    'Set the key in /home/harlan/.config/opencode/opencode.json.',
    'The sibling /home/agent_x/cache stays.',
    'Paths like /home/harlan/scratchpad stay.',
    'The host notes.localhost.example.com stays.',
    'Encode 100% of the input with &amp; escapes.',
  ])('keeps a public line after normalising it: %s', (line) => {
    expect(redactPrivateDetails(line, details)).toEqual({ text: line, hits: [] })
  })

  it('keeps line numbers when an entity decodes to a line break', () => {
    expect(redactPrivateDetails('First &#10; line\nOpen ~/notes/a.md\nLast line', details).text)
      .toBe(`First &#10; line\n${removed}\nLast line`)
  })

  it('keeps the accepted write when the Incident cannot be recorded', async () => {
    const logged: string[] = []
    const guard = createPublicTextGuard({
      details,
      store: { recordIncident: () => { throw new Error('database is locked') }, retainPrivateDetails: value => value },
      now: () => new Date('2026-11-22T06:05:00.000Z'),
      log: message => logged.push(message),
    })

    expect(await publicBody(guard, { repository: 'harlan-zw/example', itemNumber: 24, writer: 'comment' }, 'See ~/notes/a.md.').send(async () => 'written')).toBe('written')
    expect(logged).toEqual([expect.stringContaining('database is locked')])
  })

  it('names the issue number GitHub returns, and removes a private title', async () => {
    const store = journal()
    const created: Array<{ title: string, body: string }> = []
    const publisher = createGitHubIssuePublisher({
      createClient: () => ({ rest: { issues: { create: async (input: { title: string, body: string }) => {
        created.push(input)
        return { data: { number: 812, html_url: 'https://github.com/harlan-zw/example/issues/812' } }
      } } } }) as unknown as Octokit,
      publicText: createPublicTextGuard({ details, store, now: () => new Date('2026-11-22T06:05:00.000Z'), log: () => {} }),
      tokens: { getToken: async () => ok({ token: 'token', expiresAt: '2099-01-01T00:00:00.000Z' }), invalidate: () => undefined },
    })

    expect(await publisher.createIssue({ repository: repositoryMapping(), title: 'Fix the cache in ~/pkg/example/src', body: 'The cache in ~/pkg/example/src leaks.' })).toEqual(ok({ number: 812, url: 'https://github.com/harlan-zw/example/issues/812' }))
    expect(created).toEqual([expect.objectContaining({ title: removed, body: removed })])
    expect(store.listIncidents().map(incident => incident.message)).toEqual([expect.stringContaining('harlan-zw/example#812')])
  })
})

describe('rendered views stay aligned and complete', () => {
  it('keeps every view aligned with the source when a tag spans two lines', () => {
    expect(redactPrivateDetails('if a <b\n> quoted\nOpen ~/**notes**/a.md', details).text).toBe(`if a <b\n> quoted\n${removed}`)
  })

  it.each(['__/srv/agent_home/cache__', '_/srv/agent_home_', '/srv/**agent_home**/cache'])('removes a root that holds a formatting character: %s', (line) => {
    const withUnderscore = privateDetailsFor({ home: '/home/harlan', storagePath: ':memory:', checkoutRoots: [], workerHomes: ['/srv/agent_home'], serviceOrigins: [] })

    expect(redactPrivateDetails(line, withUnderscore).text).toBe(removed)
  })

  it.each([
    ['an entity-shaped suffix that never decodes', 'Open ~/notes&x; now.'],
    ['an isolate control inside a host', 'Read https://notes⁦.localhost now.'],
    ['a variation selector inside a path', 'Open ~/no️tes/a.md now.'],
    ['link brackets inside a path', 'Open ~/[notes](https://example.com)/a.md now.'],
    ['a tag with long attributes inside a path', `Open ~/<span title="${'x'.repeat(300)}">notes</span>/a.md now.`],
    ['a percent-encoded zero-width character in a host', 'Read https://notes%E2%80%8B.localhost now.'],
    ['a dot segment in a path', 'Open ~/./notes/a.md now.'],
    ['a doubled slash in a path', 'Open /home/harlan//pkg/example now.'],
    ['shell quoting around a home variable', 'Open "$HOME"/notes/a.md now.'],
    ['full-width letters in a host', 'Read https://ｎｏｔｅｓ.localhost now.'],
    ['an ideographic full stop in a host', 'Read https://notes。localhost now.'],
  ])('removes the line for %s', (_name, line) => {
    expect(redactPrivateDetails(line, details).text).toBe(removed)
  })

  it('removes the line for an inline HTML comment inside a path, and keeps the comment as a marker', () => {
    expect(redactPrivateDetails('Open ~/no<!-- -->tes/a.md now.', details).text).toBe(`${removed} <!-- -->`)
  })
})

describe('review findings on #754, follow-ups', () => {
  it.each<PublicTextWriter>(['automated review', 'automated triage', 'review comment', 'review', 'comment', 'issue', 'pull request description', 'release comment', 'GitHub release'])('removes nested wrapped links at the %s boundary', async (writer) => {
    for (const link of [
      '[private acquisition\n[plan]](https://notes.localhost/a.pdf)',
      '[report](https://notes.localhost/a(b(c)).pdf "private\nacquisition title")',
    ]) {
      const source = `Public before.\n\n${link}\n\nPublic after.`
      const expected = `Public before.\n\n${link.split('\n').map(() => removed).join('\n')}\n\nPublic after.`
      const sent = await publicBody({ details, report: () => {} }, { repository: 'harlan-zw/example', itemNumber: 24, writer }, writer === 'review' ? encodeEntities(source) : source).send(async body => body)
      expect(sent).toBe(expected)
    }
  })

  it.each(['-', '1.', '> -', '- -'])('keeps literal code and removes a following wrapped private link after a %s list fence', (marker) => {
    const indent = marker.replace(/[^>]/g, ' ')
    const source = `${marker} \`\`\`html\n${indent} ~/notes/a.md <!--\n${indent} Public literal -->\n${indent} \`\`\`\n\n[report](https://notes.localhost/a.pdf "private\nacquisition title")\n\nPublic after.`
    const privatePrefix = marker.includes('>') ? '> ' : `${indent} `
    const expected = `${marker} \`\`\`html\n${privatePrefix}${removed}\n${indent} Public literal -->\n${indent} \`\`\`\n\n${removed}\n${removed}\n\nPublic after.`
    expect(redactPrivateDetails(source, details).text).toBe(expected)
  })

  const withheld = '_This text was withheld: it named a private path or host across lines._'
  const signal = new AbortController().signal
  const control = `  - [ ] Ask an agent to verify and fix this finding <!-- logged-finding: ${'f'.repeat(64)} -->`

  it.each([
    ['with marker lines', `<!-- harlan-agent-kit:candidate ${'a'.repeat(64)} -->\nSee <a\nhref="https://notes.\nlocalhost/example">docs</a>.`, `<!-- harlan-agent-kit:candidate ${'a'.repeat(64)} -->\n${withheld}`],
    ['without marker lines', 'See <a\nhref="https://notes.\nlocalhost/example">docs</a>.', withheld],
  ])('keeps an issue title when its body is withheld %s', async (_name, body, expected) => {
    const store = journal()
    const written: Array<{ title: string, body: string }> = []
    const write = async (input: { title: string, body: string }) => {
      written.push({ title: input.title, body: input.body })
      return { data: { number: 812, html_url: 'https://github.com/harlan-zw/example/issues/812' } }
    }
    const publisher = createGitHubIssuePublisher({
      createClient: () => ({ rest: { issues: { create: write, update: write } } }) as unknown as Octokit,
      publicText: createPublicTextGuard({ details, store, now: () => new Date('2026-11-22T06:05:00.000Z'), log: () => {} }),
      tokens: { getToken: async () => ok({ token: 'token', expiresAt: '2099-01-01T00:00:00.000Z' }), invalidate: () => undefined },
    })

    expect(await publisher.createIssue({ repository: repositoryMapping(), title: 'Fix the docs link', body })).toEqual(ok({ number: 812, url: 'https://github.com/harlan-zw/example/issues/812' }))
    expect(await publisher.updateIssue({ repository: repositoryMapping(), issueNumber: 812, title: 'Fix the docs link', body })).toEqual(ok(undefined))
    expect(written).toEqual([{ title: 'Fix the docs link', body: expected }, { title: 'Fix the docs link', body: expected }])
    expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail', message: expect.stringContaining('harlan-zw/example#812') })])
  })

  it.each([
    ['a tab', 'notes.\tlocalhost'],
    ['a carriage return', 'notes.\rlocalhost'],
    ['an encoded tab', 'notes.&#9;localhost'],
    ['a named tab', 'notes.&Tab;localhost'],
    ['an encoded line break', 'notes.&#10;localhost'],
    ['a named line break', 'notes.&NewLine;localhost'],
  ])('removes an HTML link whose private host holds %s', (_name, host) => {
    for (const tag of [`<a href="https://${host}/acquisition.pdf">docs</a>`, `<img src='https://${host}/acquisition.pdf'>`, `<a href="ht\ttps:/\t/${host}/acquisition.pdf">docs</a>`]) {
      for (const line of [`Read ${tag} now.`, encodeEntities(`Read ${tag} now.`)]) {
        const redacted = redactPrivateDetails(line, details)

        expect(redacted.text).toBe(removed)
        expect(redacted.hits).toContainEqual({ _tag: 'Link', entry: 'notes.localhost' })
      }
    }
  })

  it('keeps the release draft approval when a draft line names a private path before a comment opener', () => {
    const record = {
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      commentId: 99,
      body: '',
      plan: { _tag: 'Available', bump: 'patch', version: '1.0.1', previousVersion: '1.0.0', previousTag: 'v1.0.0', packageName: 'example', headSha: reviewHead, sourceSha: reviewHead, mergeSha: reviewHead },
      state: { _tag: 'Completed', url: 'https://github.com/harlan-zw/example/releases/tag/v1.0.1' },
      policy: '',
    } as unknown as PackageReleaseRecord
    const body = packageReleaseStatus(record, { state: { _tag: 'Drafted', text: 'Fixed the cache.\nSee ~/scratch/plan.md <!-- todo\nThanks to every contributor.' } } as ReleaseNote)
    const redacted = redactPrivateDetails(body, details)
    const ticked = redacted.text.replace(/^- \[ \] Add this draft/m, '- [x] Add this draft')

    expect(redacted.text).toBe(body.replace('> See ~/scratch/plan.md &lt;!-- todo', `> ${removed}`))
    expect(releaseNoteApproval('issue_comment', {
      action: 'edited',
      repository: { full_name: 'harlan-zw/example' },
      issue: { number: 24, pull_request: {} },
      sender: { login: 'harlan-zw' },
      comment: { id: 99, user: { login: 'harlan-github-agent[bot]' }, body: ticked },
      changes: { body: { from: redacted.text } },
    })).not.toBeNull()
  })

  it.each([
    ['a code span', 'See ~/notes/a.md and `<!--` here.', removed],
    ['a fenced block', '```html\nSee ~/notes/a.md <!-- here.\n```', `\`\`\`html\n${removed}\n\`\`\``],
    ['an encoded opener', 'See ~/notes/a.md &lt;!-- here.', removed],
    ['a comment that never closes', 'See ~/notes/a.md <!-- here.', removed],
  ])('removes only the private line when a comment opener sits in %s', (_name, first, expected) => {
    for (const later of ['Public line.', `- Follow-up\n${control}`, '\nA later paragraph. <!-- marker -->']) {
      expect(redactPrivateDetails(`${first}\n${later}`, details).text).toBe(`${expected}\n${later}`)
    }
  })

  it.each([
    ['a code span', '`/home/har<span title="&quot; > x"></span>lan/notes/a.pdf`', removed],
    ['a fenced block', '```\n/home/har<span title="&quot; > x"></span>lan/notes/a.pdf\n```', `\`\`\`\n${removed}\n\`\`\``],
    ['a code span with a comment', '`/home/har<!-- x -->lan/notes/a.pdf`', `${removed} <!-- x -->`],
  ])('removes a path that markup on one line splits inside %s', (_name, text, expected) => {
    expect(redactPrivateDetails(text, details).text).toBe(expected)
  })

  it.each([
    ['a link title', 'Read [report](https://notes.localhost/reports/ "Q3\nacquisition plan") now.'],
    ['a link label', 'Read [the\nacquisition plan](https://notes.localhost/reports/plan.md) now.'],
    ['an image label', '![chart of\nthe acquisition](https://notes.localhost/a.png) here.'],
    ['a destination after its parenthesis', 'Read [x](\nhttps://notes.localhost/docs/a(b)c.md) now.'],
    ['a destination between line breaks', 'Read [evidence](\nhttps://hogwild.tail1234.ts.net/docs/report(final)/private.pdf\n) first.'],
    ['a code span', 'Open `~/notes/\nacquisition plan.pdf` now.'],
    ['a double-backtick code span', 'Open ``~/notes/\nacquisition `plan`.pdf`` now.'],
    ['the title of a linked image', 'Read [![chart](https://example.com/c.png)](https://notes.localhost/reports/ "Q3\nacquisition plan") now.'],
  ])('removes every line of a private Markdown construct that wraps in %s', (_name, text) => {
    for (const input of [text, encodeEntities(text), text.replaceAll('\n', '\r\n')]) {
      const redacted = redactPrivateDetails(input, details)

      expect(redacted.text.split('\n').map(line => line.replace(/\r$/, ''))).toEqual(input.split('\n').map(() => removed))
      expectNoFragment(redacted.text)
    }
  })

  it('removes every line of a reference definition whose title wraps', () => {
    const redacted = redactPrivateDetails('Read [doc][ref].\n\n[ref]: https://notes.localhost/a.md\n  "acquisition plan"', details)

    expect(redacted.text).toBe(`Read [doc][ref].\n\n${removed}\n  ${removed}`)
    expectNoFragment(redacted.text)
  })

  it.each([
    ['a blank line', 'Read [report](https://notes.localhost/a.md "Q3\n\nacquisition") now.', `${removed}\n\nacquisition") now.`],
    ['a list item', 'Open `~/notes/a.md\n- next` item.', `${removed}\n- next\` item.`],
  ])('keeps a line that %s separates from a private line', (_name, text, expected) => {
    expect(redactPrivateDetails(text, details).text).toBe(expected)
  })

  it('refuses a stale edit when GitHub holds a newer Review that differs only on a removed line', async () => {
    const store = journal()
    const host = commentHost()
    const published = await agentSource(host.client, store).upsertReviewStatus(repositoryMapping(), 24, null, reviewBody('Notes: ~/notes/review-24.md'), false, signal)
    if (published._tag === 'Err')
      throw new Error(published.error)
    const newer = host.comments[0]?.body

    const edited = await agentSource(host.client, store).editReviewStatus(repositoryMapping(), 24, published.value.commentId, reviewBody('Notes: none.'), reviewBody('Notes: none.', 'STOPPED'), signal)

    expect(edited).toEqual(ok({ _tag: 'Changed' }))
    expect(host.comments[0]?.body).toBe(newer)
  })

  it('refuses a stale edit when GitHub holds a newer withheld Review with the same markers', async () => {
    const store = journal()
    const host = commentHost()
    const published = await agentSource(host.client, store).upsertReviewStatus(repositoryMapping(), 24, null, reviewBody('See <a\nhref="https://notes.\nlocalhost/example">docs</a>.'), false, signal)
    if (published._tag === 'Err')
      throw new Error(published.error)
    const newer = host.comments[0]?.body

    const edited = await agentSource(host.client, store).editReviewStatus(repositoryMapping(), 24, published.value.commentId, reviewBody('No notes.'), reviewBody('No notes.', 'STOPPED'), signal)

    expect(newer).toContain(withheld)
    expect(edited).toEqual(ok({ _tag: 'Changed' }))
    expect(host.comments[0]?.body).toBe(newer)
  })

  it('edits a Review whose removed line and ticked control GitHub holds', async () => {
    const store = journal()
    const host = commentHost()
    const before = reviewBody(`Notes: ~/notes/review-24.md\n\n- Follow-up\n${control}`)
    const published = await agentSource(host.client, store).upsertReviewStatus(repositoryMapping(), 24, null, before, false, signal)
    if (published._tag === 'Err')
      throw new Error(published.error)
    const comment = host.comments[0]!
    comment.body = comment.body.replace('- [ ] Ask', '- [x] Ask')

    const edited = await agentSource(host.client, store).editReviewStatus(repositoryMapping(), 24, published.value.commentId, before, reviewBody('Stopped.', 'STOPPED'), signal)

    expect(edited).toEqual(ok(expect.objectContaining({ _tag: 'Edited' })))
    expect(comment.body).toBe(reviewBody('Stopped.', 'STOPPED'))
  })
})

/** The fastest of five runs, in milliseconds, so one slow run on a busy runner cannot decide. */
function fastest(run: () => void): number {
  let best = Number.POSITIVE_INFINITY
  for (let attempt = 0; attempt < 5; attempt++) {
    const started = performance.now()
    run()
    best = Math.min(best, performance.now() - started)
  }
  return best
}

/**
 * Asserts that redaction scales linearly, whatever the runner's speed.
 *
 * Four times the input costs about 4 times the work when linear and 16 times
 * when quadratic, so a ratio below 10 separates them. The absolute ceiling is
 * only a hang guard.
 */
function expectLinear(build: (size: number) => string): void {
  const small = build(16_384)
  const large = build(65_536)
  const smallTime = fastest(() => redactPrivateDetails(small, details))
  const largeTime = fastest(() => redactPrivateDetails(large, details))
  expect(largeTime).toBeLessThan(2_000)
  expect(largeTime / Math.max(smallTime, 1)).toBeLessThan(10)
}

describe('redaction time', () => {
  it.each(['[', '](', '<https://', '`', '"', 'a.', '![x](', '[a', '&#96;', '//', '~/notes/a ', '\n', 'a\n', '~/notes/a\n', '](https://notes.localhost/a', '[x](https://notes.localhost/a)', '](https://notes.localhost/a)\n', '[x](y "', '[x](y \'', '[x](y (', '[x\n', '](\n', '`` ```\n`', '> ```\n', '```\n<!--\n', '`<!--` ', '<b title="\n- ', '\t', '&#9;'])('scales linearly on repeated %j', (unit) => {
    expectLinear(size => unit.repeat(Math.ceil(size / unit.length)).slice(0, size))
  })

  it.each(['<!--', '&#8203;', '%2F', '\\~', '&sol;', '<b ', '[[', '((', '%E2%80%8B', '<!-- ', '<!--\n- ', '`<!--', '[x](y "\n', '`\n', '<a href="https://notes.\tlocalhost/'])('scales linearly on a private line followed by repeated %j', (unit) => {
    expectLinear(size => `~/notes/a ${unit.repeat(Math.ceil(size / unit.length))}`.slice(0, size))
  })
})
