import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

function pnpm(cwd: string, args: string[], capture = false, executable = 'pnpm'): string {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    // Explicit approved scripts still run. Nested installs must keep scripts disabled.
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  })
  if (result.error)
    throw result.error
  if (result.status !== 0)
    throw new Error('Worktree dependency preparation failed.')
  return result.stdout ?? ''
}

function command(cwd: string, executable: string, args: string[]) {
  const result = spawnSync(executable, args, { cwd, stdio: 'inherit' })
  if (result.error)
    throw result.error
  if (result.status !== 0)
    throw new Error('Approved dependency preparation failed.')
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function approvals(value: unknown) {
  if (!record(value))
    return []
  return Object.entries(value).flatMap(([key, allowed]) => {
    if (allowed !== true)
      return []
    const match = /^(@[^/]+\/[^@]+|[^@/]+)@(.+)$/.exec(key)
    if (!match)
      return []
    const name = match[1]!
    const spec = match[2]!
    // Mutable refs cannot authorize code execution during worktree creation.
    const archive = /^https:\/\/codeload\.github\.com\/[^/]+\/[^/]+\/tar\.gz\/[a-f\d]{40}$/.test(spec)
    const git = /^git\+(https:\/\/[^#]+|file:\/\/[^#]+)#[a-f\d]{40}$/.exec(spec)
    return archive || git ? [{ name, spec, git: git ? { repo: git[1]!, revision: spec.slice(-40) } : undefined }] : []
  })
}

/** Install branch dependencies without executing branch or dependency lifecycle scripts. */
export async function installWorktreeDependencies(primary: string, branch: string) {
  const allowed = approvals(JSON.parse(pnpm(primary, ['config', 'get', 'allowBuilds', '--json'], true)))
  const preparation = mkdtempSync(join(tmpdir(), 'worktrunk-install-'))
  try {
    // This manifest contains only trusted, immutable approvals. No branch files enter preparation.
    const packageManager = `pnpm@${pnpm(primary, ['--version'], true).trim()}`
    writeFileSync(join(preparation, 'package.json'), JSON.stringify({ private: true, packageManager, scripts: { executable: 'node -p "process.env.npm_execpath"' } }))
    const executable = pnpm(preparation, ['--silent', 'run', 'executable'], true).trim()
    if (!existsSync(executable))
      throw new Error('The trusted pnpm executable is missing.')
    // Branch packageManager settings must not select another executable.
    const install = (cwd: string, args: string[]) => pnpm(cwd, ['--config.manage-package-manager-versions=false', '--config.package-manager-strict=false', '--config.verify-deps-before-run=false', ...args], false, executable)
    writeFileSync(join(preparation, 'package.json'), JSON.stringify({ private: true, packageManager }))
    const built: { source: string, storeEntry: string, name: string }[] = []
    for (const [index, approval] of allowed.entries()) {
      const source = join(preparation, `source-${index}`)
      if (approval.git) {
        command(preparation, 'git', ['clone', '--quiet', '--no-checkout', '--', approval.git.repo, source])
        command(source, 'git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', approval.git.revision])
      }
      else {
        const response = await fetch(approval.spec)
        if (!response.ok)
          throw new Error('Approved dependency download failed.')
        const archive = join(preparation, `source-${index}.tgz`)
        writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
        mkdirSync(source)
        command(preparation, 'tar', ['-xzf', archive, '--strip-components=1', '-C', source])
      }
      // Install build tools without granting their lifecycle scripts permission.
      install(source, ['install', '--ignore-scripts', '--ignore-pnpmfile', '--reporter=append-only'])
      for (const phase of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack'])
        install(source, ['--config.ignore-pnpmfile=true', 'run', '--if-present', phase])

      // A separate script-free install supplies pnpm's exact virtual store identity.
      writeFileSync(join(preparation, 'package.json'), JSON.stringify({ private: true, packageManager, dependencies: { [approval.name]: approval.spec } }))
      install(preparation, ['install', '--ignore-scripts', '--ignore-pnpmfile', '--node-linker=isolated', '--virtual-store-dir=node_modules/.pnpm', '--reporter=append-only'])
      const installed = realpathSync(join(preparation, 'node_modules', approval.name))
      const storeEntry = relative(join(preparation, 'node_modules/.pnpm'), installed).split(sep)[0]!
      built.push({ source, storeEntry, name: approval.name })
    }

    install(branch, ['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts', '--ignore-pnpmfile', '--node-linker=isolated', '--virtual-store-dir=node_modules/.pnpm', '--reporter=append-only'])
    for (const dependency of built) {
      const target = join(branch, 'node_modules/.pnpm', dependency.storeEntry, 'node_modules', dependency.name)
      // Changed git revisions receive no output or execution approval.
      if (!existsSync(target))
        continue
      const path = relative(realpathSync(branch), realpathSync(target))
      if (path.startsWith(`..${sep}`) || path === '..' || resolve(branch, path) !== target)
        throw new Error('Approved dependency target leaves the worktree.')
      // Preserve branch dependency links, but replace package files with prepared source output.
      for (const entry of readdirSync(target)) {
        if (entry !== 'node_modules')
          rmSync(join(target, entry), { recursive: true, force: true })
      }
      for (const entry of readdirSync(dependency.source)) {
        if (entry !== 'node_modules' && entry !== '.git')
          cpSync(join(dependency.source, entry), join(target, entry), { recursive: true })
      }
    }
  }
  finally {
    rmSync(preparation, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const primary = process.argv[2]
  if (!primary)
    throw new Error('The primary worktree path is required.')
  await installWorktreeDependencies(resolve(primary), process.cwd())
}
