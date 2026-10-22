const scenario = process.env.KIT_AUTH_SCENARIO
if (scenario === 'timeout') {
  setTimeout(() => {}, 30000)
}
else if (scenario === 'oversize') {
  process.stdout.write('x'.repeat(32768))
}
else if (scenario === 'failure') {
  process.stderr.write('private-token-that-must-never-reach-the-diagnostic')
  process.exitCode = 1
}
else if (scenario === 'invalid') {
  process.stdout.write('{broken')
}
else if (scenario === 'missing-status') {
  process.stdout.write(JSON.stringify({ email: 'private@example.test' }))
}
else {
  process.stdout.write(JSON.stringify({ loggedIn: scenario !== 'logout', email: 'private@example.test' }))
}
