import { describe, expect, it } from 'vitest'
import { packageReleaseCommand, planPackageRelease, releaseRequest, renderPackageRelease } from '../src/package-release.ts'

const input = {
  title: 'fix: handle empty input',
  body: '',
  merged: true,
  headSha: 'f'.repeat(40),
  sourceIncluded: true,
  sourceSha: 'a'.repeat(40),
  mergeSha: 'b'.repeat(40),
  previousTag: 'v1.2.3',
  previousVersion: '1.2.3',
  currentVersion: '1.2.3',
  packageName: 'example',
  commits: ['fix: handle empty input'],
  files: [{ filename: 'src/index.ts', patch: '+return []' }],
  complete: true,
}

describe('package releases', () => {
  it.each([
    ['export function read(value: string) {\n  return "text"\n}', 'export function read(value: string, options?: Headers) {\n  return 42\n}'],
    ['export function read(value: string) {}', 'export namespace API {\n  export function read(value: string, options?: Headers) {}\n}'],
    ['const options = "text"; export function read(value: string) { return options }', 'const options = "text"; export function read(value: string, options?: Headers) { return options }'],
    ['export function read(value: string) {}\nexport { other } from "./other"', 'export function read(value: string, options?: Headers) {}'],
  ])('blocks return and scope changes with optional parameters', (before, after) => {
    const patch = before.split('\n').map(line => `-${line}`).concat(after.split('\n').map(line => `+${line}`)).join('\n')
    expect(planPackageRelease({ ...input, files: [{ filename: 'src/index.ts', patch, source: { before, after } }] }))
      .toMatchObject({ _tag: 'Unavailable', reason: 'A public API changed. Check compatibility before releasing.' })
  })
  it('offers a patch when a function adds an optional trailing parameter', () => {
    const before = 'export function setMarkdownHeaders(event: H3Event, ctx: NegotiationContext) {}'
    const after = 'export function setMarkdownHeaders(event: H3Event, ctx: NegotiationContext, sourceHeaders?: Headers) {}'
    const patch = '-export function setMarkdownHeaders(event: H3Event, ctx: NegotiationContext) {\n+export function setMarkdownHeaders(event: H3Event, ctx: NegotiationContext, sourceHeaders?: Headers) {'
    expect(planPackageRelease({ ...input, files: [{ filename: 'src/runtime/server/utils/negotiation-response.ts', patch, source: { before, after } }] }))
      .toMatchObject({ _tag: 'Available', bump: 'patch', version: '1.2.4' })
  })
  it.each([
    ['export function read(value: string) {', 'export function read(value: string, options = {}) {'],
    ['export function read(value: string) {', 'export function read(value: string, options?: [string, number]) {'],
    ['export function read(value: string) {', 'export function read(value: string) {'],
    ['export function read(\nvalue: string\n) { return }', 'export function read(\nvalue: string,\noptions?: Headers\n) { return }'],
  ])('retains compatible function calls: %s', (before, after) => {
    expect(planPackageRelease({ ...input, files: [{ filename: 'src/index.ts', patch: `-${before}\n+${after}`, source: { before: before.endsWith('{') ? `${before}}` : before, after: after.endsWith('{') ? `${after}}` : after } }] }))
      .toMatchObject({ _tag: 'Available', version: '1.2.4' })
  })
  it.each([
    ['export function read(value: string) {', 'export function read(value: string, options: Headers) {'],
    ['export function read(value: string) {', 'export function read(value: number) {'],
    ['export function read(value: string): string {', 'export function read(value: string): number {'],
    ['export function read(value: string) {', 'export function rename(value: string) {'],
    ['export async function read(value: string) {', 'export function read(value: string) {'],
    ['export function read(value: string, options?: Headers) {', 'export function read(value: string) {'],
    ['export function read(value: string) { return 1 }', 'export function read(value: string) { return "changed" }'],
  ])('requires manual release for an incompatible function: %s', (before, after) => {
    expect(planPackageRelease({ ...input, files: [{ filename: 'src/index.ts', patch: `-${before}\n+${after}`, source: { before: before.endsWith('{') ? `${before}}` : before, after: after.endsWith('{') ? `${after}}` : after } }] }))
      .toMatchObject({ _tag: 'Unavailable', reason: 'A public API changed. Check compatibility before releasing.' })
  })
  it('offers patch for compatible fixes and minor for features', () => {
    expect(planPackageRelease(input)).toMatchObject({ _tag: 'Available', bump: 'patch', version: '1.2.4' })
    expect(planPackageRelease({ ...input, title: 'feat(parser): add streaming', commits: ['feat(parser): add streaming'] }))
      .toMatchObject({ _tag: 'Available', bump: 'minor', version: '1.3.0' })
  })
  it.each([
    { title: 'docs: explain setup' },
    { title: 'chore: refresh tooling' },
    { commits: ['fix: handle input', 'feat: add streaming'] },
    { commits: ['unclassified change'] },
    { files: [{ filename: 'src/index.ts', patch: '-export function oldApi() {}' }] },
    { merged: false },
    { sourceIncluded: false },
    { complete: false },
    { previousVersion: '1.2.3-beta.1' },
    { currentVersion: '2.0.0' },
  ])('hides an unsafe or irrelevant action: %j', (change) => {
    expect(planPackageRelease({ ...input, ...change })._tag).toBe('Unavailable')
  })
  it.each([
    { title: 'feat!: remove option' },
    { body: 'BREAKING CHANGE: remove option' },
    { commits: ['feat!: require Nuxt 4.6', 'fix: handle input'] },
    { previousVersion: '0.2.0', commits: ['feat!: remove option'] },
  ])('explains that annotated breaking changes need a manual major release: %j', (change) => {
    expect(planPackageRelease({ ...input, ...change })).toMatchObject({
      _tag: 'ManualMajor',
      reason: 'This release includes breaking changes. Run a manual major release. Automatic releases support patch and minor only.',
      previousTag: input.previousTag,
      headSha: input.headSha,
    })
  })
  it('uses an already merged version bump', () => {
    expect(planPackageRelease({ ...input, currentVersion: '1.2.4' })).toMatchObject({ _tag: 'Available', version: '1.2.4' })
  })
  it('accepts only the checkbox transition from the stored offer', () => {
    const plan = planPackageRelease(input)
    if (plan._tag !== 'Available')
      throw new Error('Expected release')
    const before = renderPackageRelease(plan)
    const payload = { action: 'edited', repository: { full_name: 'harlan-zw/example' }, issue: { number: 12, pull_request: {} }, sender: { login: 'harlan-zw' }, comment: { id: 99, user: { login: 'harlan-github-agent[bot]' }, body: before.replace('- [ ]', '- [x]') }, changes: { body: { from: before } } }
    expect(releaseRequest('issue_comment', payload)).toMatchObject({ commentId: 99, requestedBy: 'harlan-zw', before })
    expect(releaseRequest('issue_comment', { ...payload, action: 'created' })).toBeNull()
    expect(releaseRequest('issue_comment', { ...payload, comment: { ...payload.comment, body: `${payload.comment.body}\nextra` } })).toBeNull()
  })
})

it.each(['do release', 'do release patch', 'do release minor'])('parses a new text command: %s', (body) => {
  const payload = { action: 'created', repository: { full_name: 'harlan-zw/example' }, issue: { number: 24, pull_request: {} }, sender: { login: 'harlan-zw' }, comment: { id: 100, user: { login: 'harlan-zw' }, body } }
  expect(packageReleaseCommand('issue_comment', payload)?.bump).toBe(body.split(' ')[2] ?? 'auto')
  expect(packageReleaseCommand('issue_comment', { ...payload, action: 'edited' })).toBeNull()
  expect(packageReleaseCommand('issue_comment', { ...payload, comment: { ...payload.comment, body: 'do release major' } })).toBeNull()
  expect(packageReleaseCommand('issue_comment', { ...payload, comment: { ...payload.comment, body: '> do release' } })).toBeNull()
})

it.each(['x', 'X'])('accepts clearing a pre-merge selection marked %s', (mark) => {
  const before = `<!-- harlan-agent-kit:package-release -->\n- [${mark}] Release minor after merge\n`
  const payload = { action: 'edited', repository: { full_name: 'harlan-zw/example' }, issue: { number: 12, pull_request: {} }, sender: { login: 'harlan-zw' }, comment: { id: 99, user: { login: 'harlan-github-agent[bot]' }, body: before.replace(`[${mark}]`, '[ ]') }, changes: { body: { from: before } } }
  expect(releaseRequest('issue_comment', payload)).toMatchObject({ selected: false, before })
  expect(releaseRequest('issue_comment', { ...payload, comment: { ...payload.comment, body: `${payload.comment.body}changed` } })).toBeNull()
})
