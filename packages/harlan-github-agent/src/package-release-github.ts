import type { GitHubTokenProvider } from './github-auth.ts'
import type { PackageReleaseSource } from './package-release-controller.ts'
import type { PackageReleaseOffer } from './package-release.ts'
import type { GitHubRepositoryAccess, RepositoryMapping, StoredReviewForHead } from './types.ts'
import { Buffer } from 'node:buffer'
import { Octokit } from 'octokit'
import { parse } from 'yaml'
import { failFastThrottle } from './github-rate-limit.ts'
import { PACKAGE_RELEASE_MARKER, planPackageRelease, planPackageReleaseBeforeMerge, stableVersion } from './package-release.ts'

interface Manifest { name?: string, version: string, private?: boolean, [key: string]: unknown }

/** All remote writes stay in the controller, with a fresh lease and repository credential. */
export function createPackageReleaseSource(options: {
  repository: RepositoryMapping
  tokens: GitHubTokenProvider
  actorLogin: string
  assertLease: () => void
  review: (number: number, sha: string) => StoredReviewForHead
  template: () => Promise<string>
  signal: AbortSignal
  now: () => Date
  fetch?: typeof globalThis.fetch
  createClient?: (token: string) => Octokit
}): PackageReleaseSource {
  const { repository, signal, assertLease } = options
  const config = repository.release
  if (config === undefined)
    throw new Error('Package releases are disabled.')
  const [owner = '', repo = ''] = repository.github.split('/')
  const scope = { owner, repo }
  const request = { signal, timeout: 30_000 }
  const client = async (access: GitHubRepositoryAccess): Promise<Octokit> => {
    assertLease()
    const result = await options.tokens.getToken(repository.github, access, signal)
    if (result._tag === 'Err')
      throw new Error(result.error.message)
    const octokit = options.createClient?.(result.value.token) ?? new Octokit({ auth: result.value.token, request, throttle: failFastThrottle })
    octokit.hook.before('request', () => assertLease())
    return octokit
  }
  const getRef = async (ref: string): Promise<string | null> => {
    const api = await client('read')
    return api.rest.git.getRef({ ...scope, ref }).then(result => result.data.object.sha).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404)
        return null
      throw error
    })
  }
  const sourceSha = async (): Promise<string> => {
    const sha = await getRef(`heads/${repository.defaultBranch}`)
    if (sha === null)
      throw new Error('The default branch is missing.')
    return sha
  }
  const content = async (path: string, ref: string): Promise<string> => {
    const api = await client('read')
    const { data } = await api.rest.repos.getContent({ ...scope, path, ref })
    if (Array.isArray(data) || data.type !== 'file' || !('content' in data))
      throw new Error(`Release file ${path} is unavailable.`)
    return Buffer.from(data.content, 'base64').toString('utf8')
  }
  const manifest = async (path: string, sha: string): Promise<Manifest> => {
    const value: unknown = JSON.parse(await content(path, sha))
    if (typeof value !== 'object' || value === null || !('version' in value)
      || typeof value.version !== 'string' || stableVersion(value.version) === null) {
      throw new Error(`Release file ${path} needs a stable version.`)
    }
    return value as Manifest
  }
  const registry = async (name: string): Promise<{ 'versions': Record<string, { version: string, gitHead?: string }>, 'dist-tags': Record<string, string> }> => {
    const response = await (options.fetch ?? globalThis.fetch)(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
    if (!response.ok)
      throw new Error(`npm could not read ${name}: HTTP ${response.status}.`)
    const value = await response.json() as { 'versions'?: unknown, 'dist-tags'?: unknown }
    if (typeof value.versions !== 'object' || value.versions === null || typeof value['dist-tags'] !== 'object' || value['dist-tags'] === null)
      throw new Error('npm returned an invalid package record.')
    return value as { 'versions': Record<string, { version: string, gitHead?: string }>, 'dist-tags': Record<string, string> }
  }
  const checkRunsPassed = async (sha: string, defaultBranch = false): Promise<boolean> => {
    const api = await client('checks_read')
    const checks = await api.paginate(api.rest.checks.listForRef, { ...scope, ref: sha, per_page: 100, filter: defaultBranch ? 'all' : 'latest' })
    // A passing pull request check on the same SHA is not default branch CI evidence.
    const runs = defaultBranch
      ? await api.paginate(api.rest.actions.listWorkflowRunsForRepo, { ...scope, head_sha: sha, event: 'push', branch: repository.defaultBranch, per_page: 100 })
      : []
    const suites = new Set(runs.filter(run => run.head_sha === sha && run.event === 'push'
      && run.head_branch === repository.defaultBranch && run.status === 'completed' && run.conclusion === 'success')
      .map(run => run.check_suite_id))
    // Tag workflows can reuse check names. Keep the newest attempt within each check suite.
    const latest = checks.filter(check => !checks.some(other => other.name === check.name
      && other.check_suite?.id === check.check_suite?.id && other.id > check.id))
    return config.checks.every(name => latest.some(check => (!defaultBranch || suites.has(check.check_suite?.id)) && check.name === name && check.app?.slug === 'github-actions'
      && check.status === 'completed' && check.conclusion === 'success'))
  }
  const blocked = (reason: string) => ({ _tag: 'Blocked' as const, reason })
  const inspect = async (number: number): Promise<PackageReleaseOffer> => {
    const unavailable = (reason: string): PackageReleaseOffer => ({ _tag: 'Unavailable', reason })
    if (!repository.pullRequestReview || !repository.writablePullRequestAuthors.some(author => author.toLowerCase() === options.actorLogin.toLowerCase()))
      return unavailable('Release preparation requires Review and a trusted publishing author.')
    const api = await client('read')
    const pull = (await api.rest.pulls.get({ ...scope, pull_number: number })).data
    if (pull.base.ref !== repository.defaultBranch || pull.draft || (!pull.merged && pull.state !== 'open'))
      return unavailable('The pull request must be open or merged into the default branch.')
    if (!/^(?:feat|fix|perf)(?:\([^\n]*\))?:/i.test(pull.title))
      return unavailable('This pull request does not need a package release.')
    const sha = await sourceSha()
    const pkg = await manifest(config.manifest, sha)
    if (pkg.private || typeof pkg.name !== 'string' || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(pkg.name))
      return unavailable('The configured package is not a public npm package.')
    const npm = await registry(pkg.name)
    const version = npm['dist-tags'].latest
    if (version === undefined || stableVersion(version) === null)
      return unavailable('The package has no stable latest release.')
    const tag = `${config.tagPrefix}${version}`
    const previousSha = await getRef(`tags/${tag}`)
    if (previousSha === null)
      return unavailable('The published version has no matching Git tag.')
    const range = (await api.rest.repos.compareCommits({ ...scope, base: tag, head: sha })).data
    const workflow: unknown = parse(await content(`.github/workflows/${config.workflow}`, sha))
    const triggers = typeof workflow === 'object' && workflow !== null && 'on' in workflow ? workflow.on : null
    if (typeof triggers !== 'object' || triggers === null || !('push' in triggers))
      return unavailable('The release workflow must publish from a tag push.')
    const push = triggers.push
    if (typeof push !== 'object' || push === null || !('tags' in push) || !Array.isArray(push.tags)
      || !push.tags.some(pattern => pattern === `${config.tagPrefix}*` || pattern === '*' || pattern === '**')) {
      return unavailable('The release workflow must match the configured tag prefix.')
    }
    const common = {
      title: pull.title,
      body: pull.body ?? '',
      headSha: pull.head.sha,
      previousTag: tag,
      previousVersion: version,
      currentVersion: pkg.version,
      packageName: pkg.name,
      commits: range.commits.map(commit => commit.commit.message),
      files: (range.files ?? []).map(file => ({ filename: file.filename, patch: file.patch ?? '' })),
      complete: ['ahead', 'identical'].includes(range.status) && range.total_commits === range.commits.length
        && range.commits.length < 250 && range.files !== undefined && range.files.length < 300
        && range.files.every(file => file.patch !== undefined),
    }
    if (!pull.merged) {
      const [commits, files] = await Promise.all([
        api.paginate(api.rest.pulls.listCommits, { ...scope, pull_number: number, per_page: 100 }),
        api.paginate(api.rest.pulls.listFiles, { ...scope, pull_number: number, per_page: 100 }),
      ])
      // Re-read after the unpinned pull request APIs. Never bind a new diff to an old head.
      const current = (await api.rest.pulls.get({ ...scope, pull_number: number })).data
      if (current.head.sha !== pull.head.sha || current.base.sha !== pull.base.sha
        || current.base.ref !== pull.base.ref || current.title !== pull.title || current.body !== pull.body
        || current.state !== pull.state || current.draft !== pull.draft || current.merged !== pull.merged) {
        return unavailable('The pull request changed while reading its release range.')
      }
      return planPackageReleaseBeforeMerge({ ...common, commits: [...common.commits, ...commits.map(commit => commit.commit.message)], files: [...common.files, ...files.map(file => ({ filename: file.filename, patch: file.patch ?? '' }))], complete: common.complete && commits.length === pull.commits && commits.length < 250
        && files.length === pull.changed_files && files.length < 300 && files.every(file => file.patch !== undefined) })
    }
    return planPackageRelease({ ...common, merged: true, sourceIncluded: pull.merge_commit_sha !== null && range.commits.some(commit => commit.sha === pull.merge_commit_sha), sourceSha: sha, mergeSha: pull.merge_commit_sha ?? '' })
  }

  const comment: PackageReleaseSource['comment'] = async (number, body, commentId) => {
    const api = await client('item_write')
    // Search on recovery too. A lost create response must not post another comment.
    // A deleted comment falls back to the search, so the pass recreates it instead of failing forever.
    const stored = commentId === undefined
      ? null
      : await api.rest.issues.getComment({ ...scope, comment_id: commentId }).then(result => result.data).catch((error: unknown) => {
          if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404)
            return null
          throw error
        })
    const comments = stored === null
      ? await api.paginate(api.rest.issues.listComments, { ...scope, issue_number: number, per_page: 100 })
      : [stored]
    const existing = comments.find(comment => comment.user?.login.toLowerCase() === options.actorLogin.toLowerCase()
      && comment.issue_url.endsWith(`/issues/${number}`) && comment.body?.startsWith(PACKAGE_RELEASE_MARKER))
    if (stored !== null && existing === undefined)
      throw new Error('The release comment no longer belongs to this Task.')
    if (existing !== undefined) {
      if (existing.body !== body)
        await api.rest.issues.updateComment({ ...scope, comment_id: existing.id, body })
      return existing.id
    }
    return (await api.rest.issues.createComment({ ...scope, issue_number: number, body })).data.id
  }
  return {
    inspect,
    comment,
    async candidates() {
      const api = await client('read')
      const numbers: number[] = []
      const cutoff = options.now().getTime() - 7 * 86_400_000
      const open = await api.paginate(api.rest.pulls.list, { ...scope, state: 'open', base: repository.defaultBranch, per_page: 100 })
      numbers.push(...open.filter(pull => !pull.draft && /^(?:feat|fix|perf)(?:\([^\n]*\))?:/i.test(pull.title)).map(pull => pull.number))
      for await (const response of api.paginate.iterator(api.rest.pulls.list, { ...scope, state: 'closed', base: repository.defaultBranch, sort: 'updated', direction: 'desc', per_page: 100 })) {
        for (const pull of response.data) {
          if (Date.parse(pull.updated_at) < cutoff)
            return numbers
          if (pull.merged_at !== null && /^(?:feat|fix|perf)(?:\([^\n]*\))?:/i.test(pull.title))
            numbers.push(pull.number)
        }
      }
      return numbers
    },
    async prepare(record) {
      const plan = record.plan
      if (await sourceSha() !== plan.sourceSha)
        return blocked('The default branch advanced. Request a release from its latest merged pull request.')
      if (!await checkRunsPassed(plan.sourceSha, true))
        return null
      const current = await manifest(config.manifest, plan.sourceSha)
      const tag = `${config.tagPrefix}${plan.version}`
      if (current.version === plan.version)
        return { _tag: 'Publishing', tag, sha: plan.sourceSha }
      if (!repository.writablePullRequestAuthors.some(author => author.toLowerCase() === options.actorLogin.toLowerCase()))
        return blocked('Add the GitHub App author to writable_pr_authors before enabling release preparation.')
      const files = await Promise.all(config.versionFiles.map(async (path) => {
        const value = await manifest(path, plan.sourceSha)
        if (value.version !== plan.previousVersion)
          throw new Error(`Release file ${path} has a different version.`)
        return { path, mode: '100644' as const, type: 'blob' as const, content: `${JSON.stringify({ ...value, version: plan.version }, null, 2)}\n` }
      }))
      if (config.changelog !== undefined) {
        const reader = await client('read')
        const range = (await reader.rest.repos.compareCommits({ ...scope, base: plan.previousTag, head: plan.sourceSha })).data
        const changes = range.commits.map(commit => `- ${commit.commit.message.split('\n')[0]?.replace(/[[\]<>]/g, '')} ([${commit.sha.slice(0, 7)}](https://github.com/${repository.github}/commit/${commit.sha}))`).join('\n')
        const section = `## ${plan.version}\n\n[Compare changes](https://github.com/${repository.github}/compare/${plan.previousTag}...${tag})\n\n${changes}\n\n`
        files.push({ path: config.changelog, mode: '100644', type: 'blob', content: `${section}${await content(config.changelog, plan.sourceSha)}` })
      }
      const api = await client('contents_write')
      const base = (await api.rest.git.getCommit({ ...scope, commit_sha: plan.sourceSha })).data
      const tree = (await api.rest.git.createTree({ ...scope, base_tree: base.tree.sha, tree: files })).data
      const branch = `release/${record.pullRequestNumber}-${plan.version}`
      let headSha = await getRef(`heads/${branch}`)
      if (headSha === null) {
        const commit = (await api.rest.git.createCommit({ ...scope, tree: tree.sha, parents: [plan.sourceSha], message: `chore(release): prepare ${tag}` })).data
        if (await sourceSha() !== plan.sourceSha)
          return blocked('The default branch advanced. Request a release from its latest merged pull request.')
        await api.rest.git.createRef({ ...scope, ref: `refs/heads/${branch}`, sha: commit.sha })
        headSha = commit.sha
      }
      else {
        const commit = (await api.rest.git.getCommit({ ...scope, commit_sha: headSha })).data
        if (commit.tree.sha !== tree.sha || commit.parents.length !== 1 || commit.parents[0]?.sha !== plan.sourceSha)
          return blocked('The release branch changed outside this Task.')
      }
      const description = `Release ${plan.packageName}@${plan.version}, requested on #${record.pullRequestNumber}.`
      const template = (await options.template()).replace(/^- \[ \] 🧹 Chore$/m, '- [x] 🧹 Chore').replace(/^> 🤖 AI disclosure:.*$/gm, '').trimEnd()
      const body = `${template}\n\n${description}\n\n> 🤖 AI disclosure: [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) modified this description. [My AI open-source policy](https://harlanzw.com/blog/ai-in-open-source).`
      const writer = await client('item_write')
      const existing = (await writer.rest.pulls.list({ ...scope, state: 'all', head: `${owner}:${branch}`, base: repository.defaultBranch })).data
      const pull = existing[0] ?? (await writer.rest.pulls.create({ ...scope, head: branch, base: repository.defaultBranch, title: `chore(release): prepare ${tag}`, body })).data
      return { _tag: 'Prepared', pullRequestNumber: pull.number, headSha, branch }
    },
    async merge(record) {
      const api = await client('read')
      const pull = (await api.rest.pulls.get({ ...scope, pull_number: record.state.pullRequestNumber })).data
      if (pull.head.sha !== record.state.headSha || pull.base.ref !== repository.defaultBranch)
        return blocked('The release pull request changed outside this Task.')
      if (pull.merged) {
        if (pull.merge_commit_sha === null)
          throw new Error('The release merge commit is unavailable.')
        // A human merge can include a newer base. Verify the exact published tree before tagging.
        const merged = (await api.rest.git.getCommit({ ...scope, commit_sha: pull.merge_commit_sha })).data
        const prepared = (await api.rest.git.getCommit({ ...scope, commit_sha: record.state.headSha })).data
        if (merged.tree.sha !== prepared.tree.sha)
          return blocked('The release merge includes unverified changes.')
        return { _tag: 'Publishing', tag: `${config.tagPrefix}${record.plan.version}`, sha: pull.merge_commit_sha }
      }
      if (pull.state === 'closed')
        return blocked('The release pull request was closed without merging.')
      if (await sourceSha() !== record.plan.sourceSha)
        return blocked('The default branch advanced. Request a release from its latest merged pull request.')
      const review = options.review(pull.number, record.state.headSha)
      if (review._tag !== 'Current' || review.run.outcome._tag !== 'Ready'
        || (review.run.outcome.confidence ?? 0) < 90 || review.run.baseRef !== repository.defaultBranch
        || Object.values(review.run.gates).some(gate => gate._tag !== 'Passed')) {
        return null
      }
      if (!await checkRunsPassed(record.state.headSha) || pull.mergeable_state !== 'clean')
        return null
      if (await sourceSha() !== record.plan.sourceSha)
        return blocked('The default branch advanced. Request a release from its latest merged pull request.')
      const writer = await client('pull_request_merge')
      const merged = (await writer.rest.pulls.merge({ ...scope, pull_number: pull.number, sha: record.state.headSha, merge_method: 'squash' })).data
      if (!merged.merged)
        throw new Error('GitHub did not merge the release pull request.')
      // Re-read on the next pass to verify the merge tree, including any concurrent base movement.
      return null
    },
    async publish(record) {
      const { sha, tag } = record.state
      if (!await checkRunsPassed(sha, true))
        return null
      const existing = await getRef(`tags/${tag}`)
      if (existing !== null && existing !== sha)
        return blocked('The release tag already points to a different commit.')
      if (existing === null) {
        // The pinned commit must remain on the default branch, even after a fast-forward.
        const reader = await client('read')
        const range = (await reader.rest.repos.compareCommits({ ...scope, base: sha, head: await sourceSha() })).data
        if (!['ahead', 'identical'].includes(range.status))
          return blocked('The release commit left the default branch.')
        const writer = await client('contents_write')
        await writer.rest.git.createRef({ ...scope, ref: `refs/tags/${tag}`, sha })
      }
      const reader = await client('checks_read')
      const runs = (await reader.rest.actions.listWorkflowRuns({ ...scope, workflow_id: config.workflow, head_sha: sha, event: 'push', per_page: 100 })).data.workflow_runs.filter(run => run.head_branch === tag).sort((a, b) => b.id - a.id)
      const run = runs[0]
      if (run === undefined || run.status !== 'completed')
        return null
      if (run.conclusion !== 'success')
        throw new Error(`Release workflow failed: ${run.html_url}. Re-run that workflow for the same version.`)
      for (const path of config.versionFiles.filter(path => path.endsWith('package.json'))) {
        const pkg = await manifest(path, sha)
        if (pkg.private)
          continue
        if (typeof pkg.name !== 'string')
          throw new Error('A public release package has no npm name.')
        const npm = await registry(pkg.name)
        if (npm.versions[record.plan.version]?.version !== record.plan.version || npm['dist-tags'].latest !== record.plan.version)
          return null
      }
      const github = await client('read')
      const release = await github.rest.repos.getReleaseByTag({ ...scope, tag })
      if (release.data.draft || release.data.prerelease)
        throw new Error('The GitHub release is not a published stable release.')
      return release.data.html_url
    },
  }
}
