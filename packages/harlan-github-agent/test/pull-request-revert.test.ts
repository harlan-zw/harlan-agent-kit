import { describe, expect, it } from 'vitest'
import { revertTarget } from '../src/pull-request-revert.ts'

const repository = 'harlan-zw/example'
const sha = 'a1b2c3d4'.repeat(5)

describe('revertTarget', () => {
  // Each title keeps the shape of a real revert. The words are made up.
  it.each([
    ['GitHub\'s Revert button', 'Revert "docs(guide): add a setup section"', `Reverts ${repository}#700`, { _tag: 'PullRequest', number: 700 }],
    ['the Revert button with a lowercase repository spelling', 'Revert "fix: x"', 'Reverts Harlan-ZW/Example#12\n\nIt broke the build.', { _tag: 'PullRequest', number: 12 }],
    ['a conventional subject that names the pull request', 'chore: revert the config shim from #714', '', { _tag: 'PullRequest', number: 714 }],
    ['the revert type', 'revert: parser change (#26), it broke the build', '', { _tag: 'PullRequest', number: 26 }],
    ['git revert of a merge commit', 'Revert "Merge pull request #6 from harlan-zw/notice"', '', { _tag: 'PullRequest', number: 6 }],
    ['git revert of a squash commit, by its exact commit', 'Revert "fix: use the native parser (#41)"', `This reverts commit ${sha}.`, { _tag: 'Commit', sha }],
    ['the exact commit over a reference the quoted subject happens to make', 'Revert "fix: parser crash from #12"', `This reverts commit ${sha}.`, { _tag: 'Commit', sha }],
    ['the title when no commit is named', 'Revert "fix: use the native parser (#41)"', '', { _tag: 'PullRequest', number: 41 }],
    ['git revert with only the commit', 'fix(ci): revert the crawl step that broke every page', `This reverts commit ${sha}.`, { _tag: 'Commit', sha }],
  ])('reads %s', (_case, title, body, expected) => {
    expect(revertTarget({ repository, title, body })).toEqual(expected)
  })

  it.each([
    ['a domain word that is not a revert', 'fix(stats): count reverts in the weekly totals (#1070)', ''],
    ['a compound word', 'fix: revert-safe parsing for #12', ''],
    ['a revert that names no pull request or commit', 'chore(deps): revert the parser package to 3.4.1', ''],
    ['two pull requests in the title', 'chore: revert #12 and #13', ''],
    ['another repository', 'Revert "fix: x"', 'Reverts other/repo#5'],
    ['a mention in prose', 'fix: tidy the parser', 'This PR reverts #4 in part and keeps the rest.'],
    ['a short commit hash', 'Revert "fix: x"', 'This reverts commit a1b2c3d.'],
  ])('ignores %s', (_case, title, body) => {
    expect(revertTarget({ repository, title, body })).toBeNull()
  })
})
