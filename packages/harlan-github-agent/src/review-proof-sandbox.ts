import type { ReviewProofProcess } from './review-proof-process.ts'
import type { ReviewProofLaunch } from './review-proof.ts'
import { mkdtemp, open, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { reviewProofSeccomp } from './review-proof-seccomp.ts'

/** Direct Node launch. No provider home, proxy socket, helper process, or repository environment is exposed. */
export async function prepareReviewProofSandbox(input: ReviewProofLaunch): Promise<ReviewProofProcess> {
  const workspace = await realpath(input.workspace)
  const source = await realpath(input.sourcePath)
  const filter = reviewProofSeccomp(process.arch)
  const args = ['--die-with-parent', '--unshare-user', '--unshare-pid', '--as-pid-1', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup', '--unshare-net', '--cap-drop', 'ALL']
  for (const path of ['/usr', '/lib', '/lib64', '/bin', '/sbin']) {
    if (await stat(path).then(() => true).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? false : Promise.reject(error)))
      args.push('--ro-bind', path, path)
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run', '--dir', '/tmp/home', '--dir', '/run/proof')
  args.push('--ro-bind', await realpath(process.execPath), '/run/proof/node', '--ro-bind', source, '/run/proof/proof.ts', '--ro-bind', workspace, workspace)
  args.push('--clearenv', '--setenv', 'HOME', '/tmp/home', '--setenv', 'LANG', 'C.UTF-8', '--chdir', workspace, '--seccomp', '3', '--', '/run/proof/node', ...input.nodeArguments)
  const temporary = await mkdtemp(join(tmpdir(), 'review-proof-filter-'))
  const filterPath = join(temporary, 'filter.bpf')
  const descriptor = await (async () => {
    await writeFile(filterPath, filter, { mode: 0o400 })
    return open(filterPath, 'r')
  })().catch(async (error: unknown) => {
    await rm(temporary, { recursive: true, force: true })
    throw error
  })
  return { binary: '/usr/bin/bwrap', arguments: args, environment: { PATH: '/usr/bin:/bin' }, extraFileDescriptors: [descriptor.fd], release: async () => {
    await descriptor.close()
    await rm(temporary, { recursive: true, force: true })
  } }
}
