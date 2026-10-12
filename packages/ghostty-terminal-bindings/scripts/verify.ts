import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyArtifacts } from './provenance.ts'

function main(): void {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  verifyArtifacts(packageRoot)
  process.stdout.write('Verified offline Ghostty artifacts, source pins, patch digests, and licenses.\n')
}
try {
  main()
}
catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
