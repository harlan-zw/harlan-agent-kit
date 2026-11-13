import { Buffer } from 'node:buffer'
import { crc32, deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { readArtifactText } from '../src/actions-artifact.ts'

interface Entry { name: string, content: Buffer, method?: 0 | 8 }

/** Writes the smallest valid zip GitHub's artifact download would return. */
function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const method = entry.method ?? 8
    const data = method === 8 ? deflateRawSync(entry.content) : entry.content
    const name = Buffer.from(entry.name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(entry.content), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(entry.content.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014B50, 0)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc32(entry.content), 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(entry.content.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, data)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

describe('readArtifactText', () => {
  it('reads the journal a failed run uploaded', () => {
    const journal = '{"step":"code-deploy-started"}\n{"step":"canary-response-json-invalid","status":400}\n'
    const archive = zip([
      { name: 'user-d1-publication.jsonl', content: Buffer.from(journal) },
      { name: 'user-d1-result.json', content: Buffer.from('{"ok":false}'), method: 0 },
    ])

    expect(readArtifactText(archive, 4_000)).toEqual({ _tag: 'Read', files: [
      { path: 'user-d1-publication.jsonl', text: journal, truncated: false },
      { path: 'user-d1-result.json', text: '{"ok":false}', truncated: false },
    ] })
  })

  it('keeps the end of a file past the budget, where a failure is written', () => {
    const archive = zip([{ name: 'log.txt', content: Buffer.from(`${'a'.repeat(50)}\nfinal failure line`) }])

    expect(readArtifactText(archive, 20)).toEqual({ _tag: 'Read', files: [{ path: 'log.txt', text: 'a\nfinal failure line', truncated: true }] })
  })

  it('names a binary file instead of printing it', () => {
    const archive = zip([{ name: 'trace.bin', content: Buffer.from([0, 1, 2, 0, 255]) }])

    expect(readArtifactText(archive, 4_000)).toEqual({ _tag: 'Read', files: [{ path: 'trace.bin', text: null, truncated: false }] })
  })

  it('refuses bytes that are not a zip archive', () => {
    expect(readArtifactText(Buffer.from('<html>Not Found</html>'), 4_000)).toEqual({ _tag: 'Unreadable', reason: 'The artifact is not a zip archive.' })
  })
})
