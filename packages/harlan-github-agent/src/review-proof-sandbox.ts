import type { ReviewProofProcess } from './review-proof-process.ts'
import type { ReviewProofLaunch } from './review-proof.ts'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, open, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { reviewProofSeccomp } from './review-proof-seccomp.ts'

/** Direct Node launch. No provider home, proxy socket, helper process, or repository environment is exposed. */
export async function prepareReviewProofSandbox(input: ReviewProofLaunch, limits = { memoryMaxBytes: 512 * 1024 * 1024 }): Promise<ReviewProofProcess> {
  if (!Number.isSafeInteger(limits.memoryMaxBytes) || limits.memoryMaxBytes < 32 * 1024 * 1024 || limits.memoryMaxBytes > 512 * 1024 * 1024)
    throw new Error('The Review proof memory limit must stay between 32 MiB and 512 MiB.')
  const directory = `/run/user/${process.getuid!()}`
  if (!(await stat(join(directory, 'bus'))).isSocket())
    throw new Error('The Review proof requires its controller user memory scope.')
  const unit = `harlan-review-proof-${randomUUID()}.scope`
  const environment = { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: directory, DBUS_SESSION_BUS_ADDRESS: `unix:path=${directory}/bus` }
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
  return { binary: '/usr/bin/systemd-run', arguments: ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, `--property=MemoryMax=${limits.memoryMaxBytes}`, '--property=MemorySwapMax=0', '/usr/bin/bwrap', ...args], environment, extraFileDescriptors: [descriptor.fd], release: async () => {
    try {
      await promisify(execFile)('/usr/bin/systemctl', ['--user', 'stop', unit], { env: environment, timeout: 5000 }).catch((error: { code?: number, stderr?: string }) => {
        // --collect removes completed scopes before cleanup reaches this call.
        if ((error.code === 1 || error.code === 5) && (error.stderr ?? '').includes(`Unit ${unit} not loaded`))
          return
        throw error
      })
    }
    finally {
      try {
        await descriptor.close()
      }
      finally {
        await rm(temporary, { recursive: true, force: true })
      }
    }
  } }
}
