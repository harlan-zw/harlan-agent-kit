import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Run as the Agent user, then have an administrator approve and install the output.
// This query deliberately reads no sessions, cookies, tokens, or private keys.
const directory = process.argv[2]
if (!directory || process.argv.length !== 3)
  throw new Error('Provide the browser-auth directory.')
const authority = createHash('sha256').update('https://agent.harlanzw.com').digest('hex')
const database = new DatabaseSync(join(directory, authority, 'auth.sqlite'), { readOnly: true })
try {
  const userId = database.prepare('SELECT user_id FROM account WHERE id=1').get()?.user_id
  const credentials = database.prepare('SELECT id, credential FROM credentials ORDER BY created').all().map((row) => {
    const value = JSON.parse(String(row.credential)) as { publicKey: string, counter: number }
    return { id: String(row.id), publicKey: value.publicKey, counter: value.counter }
  })
  if (typeof userId !== 'string' || credentials.length === 0)
    throw new Error('No enrolled public Passkeys.')
  process.stdout.write(`${JSON.stringify({ userId, credentials })}\n`)
}
finally { database.close() }
