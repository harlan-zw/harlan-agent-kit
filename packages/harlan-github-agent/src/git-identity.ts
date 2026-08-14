import type { Result } from './result.ts'
import { execFile } from 'node:child_process'
import { err, ok } from './result.ts'

export interface GitIdentity {
  name: string
  email: string
}

type ReadGitConfig = (key: 'user.name' | 'user.email') => Promise<Result<string, string>>

const readGlobalGitConfig: ReadGitConfig = key => new Promise((resolve) => {
  execFile('git', ['config', '--global', '--get', key], { encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error !== null) {
      resolve(err(stderr.trim() || `Global Git ${key} is not configured.`))
      return
    }
    resolve(ok(stdout.trim()))
  })
})

function safeIdentityValue(value: string): boolean {
  return value.length > 0 && !/[\0\r\n]/.test(value)
}

export async function loadGitIdentity(read: ReadGitConfig = readGlobalGitConfig): Promise<Result<GitIdentity, string>> {
  const [name, email] = await Promise.all([read('user.name'), read('user.email')])
  if (name._tag === 'Err')
    return name
  if (email._tag === 'Err')
    return email
  if (!safeIdentityValue(name.value) || !safeIdentityValue(email.value))
    return err('Global Git user.name and user.email must be non-empty single-line values.')
  return ok({ name: name.value, email: email.value })
}
