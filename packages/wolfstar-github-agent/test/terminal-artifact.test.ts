import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildTerminalArtifact } from '../src/terminal-artifact.ts'
import { verifyTerminalArtifact } from '../src/terminal-systemd.ts'

it('versions the standalone claim dependency and rejects a changed published tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-claim-artifact-'))
  try {
    const source = join(root, 'helper.ts')
    const claimScript = join(root, 'claim.sh')
    await writeFile(source, 'console.log("inert-helper")')
    await writeFile(claimScript, '#!/bin/bash\nprintf first')
    const first = await buildTerminalArtifact({ source, claimScript, directory: join(root, 'artifacts') })
    await writeFile(claimScript, '#!/bin/bash\nprintf second')
    const second = await buildTerminalArtifact({ source, claimScript, directory: join(root, 'artifacts') })
    expect(second.digest).not.toBe(first.digest)
    expect(await readFile(first.claimScript, 'utf8')).toBe('#!/bin/bash\nprintf first')
    expect(await readFile(second.claimScript, 'utf8')).toBe('#!/bin/bash\nprintf second')
    await verifyTerminalArtifact(first)
    await chmod(first.claimScript, 0o600)
    await writeFile(first.claimScript, 'changed-published-tool')
    await expect(verifyTerminalArtifact(first)).rejects.toThrow('Terminal artifact changed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
