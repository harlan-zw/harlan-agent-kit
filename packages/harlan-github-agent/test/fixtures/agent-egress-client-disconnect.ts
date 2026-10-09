import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { createAgentEgress } from '../../src/agent-egress.ts'

const socketPath = process.argv[2]!
const proxy = await createAgentEgress(socketPath)
const disconnectedRequest = process.argv[3] === 'http'
  ? 'GET http://localhost/ HTTP/1.1\r\nHost: localhost\r\n\r\n'
  : 'CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n'
try {
  for (let batch = 0; batch < 10; batch++) {
    await Promise.all(Array.from({ length: 10 }, () => new Promise<void>((resolve, reject) => {
      const client = connect(socketPath)
      client.once('error', reject)
      client.once('connect', () => client.end(disconnectedRequest, () => client.destroy()))
      client.once('close', () => resolve())
    })))
  }
  const response = await new Promise<string>((resolve, reject) => {
    const client = connect(socketPath)
    let output = ''
    client.once('error', reject)
    client.once('connect', () => client.write('CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n'))
    client.on('data', chunk => output += chunk.toString())
    client.once('end', () => resolve(output))
  })
  assert.match(response, /HTTP\/1\.1 403 Forbidden/)
  console.log('Refused the destination after disconnected clients.')
}
finally {
  await proxy.close()
}
