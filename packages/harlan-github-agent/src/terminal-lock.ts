process.stdout.write('LOCKED\n')
process.stdin.resume()
process.stdin.once('end', () => process.exit(0))
