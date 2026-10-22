import type { GitHubClient, RepositoryRef, Result, RunRecord } from '@harlan-zw/octorun'
import type { KitServiceSettings } from './config.ts'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { err, ok } from '@harlan-zw/octorun'
import { parseKitServiceConfig } from './config.ts'

/** Check and read the same file descriptor. Never follow a final path symlink. */
async function privateFile(path: string, name: string): Promise<Result<string>> {
  const opened = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .then(ok, () => err({ _tag: 'Configuration', message: `Cannot open the ${name}. Check its path and file permissions.` }))
  if (opened._tag === 'Err')
    return opened
  try {
    const metadata = await opened.value.stat()
    if (!metadata.isFile() || (process.getuid !== undefined && metadata.uid !== process.getuid())
      || (metadata.mode & 0o077) !== 0 || metadata.size > 1_048_576) {
      return err({ _tag: 'Configuration', message: `The ${name} must be an owned, private regular file of at most one MiB.` })
    }
    return await opened.value.readFile('utf8').then(ok, () => err({ _tag: 'Configuration', message: `Cannot read the ${name}. Check its file permissions.` }))
  }
  finally {
    await opened.value.close()
  }
}

export async function loadKitServiceSettings(path: string) {
  const input = await privateFile(path, 'Service configuration')
  return input._tag === 'Err' ? input : parseKitServiceConfig(input.value)
}

export async function loadKitAppPrivateKey(path: string): Promise<Result<string>> {
  const input = await privateFile(path, 'GitHub App private key')
  return input._tag === 'Err' || /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(input.value)
    ? input
    : err({ _tag: 'Configuration', message: 'The GitHub App private key must use PEM format.' })
}

/** Re-read authority before paid work and publication. Core separately checks command actors. */
export function createKitRunAuthorizer(options: { configurationPath: string, settings: KitServiceSettings, repository: RepositoryRef, client: Pick<GitHubClient, 'snapshot'> }) {
  return async (run: Pick<RunRecord, 'event'>): Promise<Result<void>> => {
    const current = await loadKitServiceSettings(options.configurationPath)
    if (current._tag === 'Err')
      return current
    const settings = current.value
    if (settings.github.appId !== options.settings.github.appId || settings.github.privateKeyPath !== options.settings.github.privateKeyPath
      || settings.repository.checkout !== options.settings.repository.checkout || settings.storagePath !== options.settings.storagePath) {
      return err({ _tag: 'Authorization', message: 'The Service authority changed. Restart Octorun after checking its configuration.' })
    }
    const { event } = run
    if (event.repository.fullName.toLowerCase() !== options.repository.fullName.toLowerCase()
      || event.repository.id !== options.repository.id || event.repository.installationId !== options.repository.installationId) {
      return err({ _tag: 'Authorization', message: 'The workflow does not match the configured repository installation.' })
    }
    // The private operator socket and Core's current write-permission check provide explicit spending authority.
    if (event.source === 'manual' || event.action === 'command' || event.name === 'octorun.conversation' || event.name === 'octorun.command')
      return ok(undefined)
    if (event.target._tag !== 'PullRequest')
      return err({ _tag: 'Authorization', message: 'Automatic Octorun work requires a configured pull request.' })
    const snapshot = await options.client.snapshot(event.repository.fullName, event.target.number)
    if (snapshot._tag === 'Err')
      return snapshot
    if (snapshot.value.repository.id !== options.repository.id || snapshot.value.repository.installationId !== options.repository.installationId
      || snapshot.value.repository.fullName.toLowerCase() !== options.repository.fullName.toLowerCase()
      || snapshot.value.headSha !== event.target.headSha || snapshot.value.baseSha !== event.target.baseSha) {
      return err({ _tag: 'Authorization', message: 'The automatic workflow no longer matches the current pull request revision.' })
    }
    return settings.repository.trustedAuthors.some(author => author.toLowerCase() === snapshot.value.author.login.toLowerCase())
      ? ok(undefined)
      : err({ _tag: 'Authorization', message: 'Automatic Octorun work requires a trusted Service author. A repository writer can request an explicit Octorun workflow.' })
  }
}
