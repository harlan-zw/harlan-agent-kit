import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const script = fileURLToPath(new URL('./ci-changes.ts', import.meta.url))

it.each([
  [[], 'code=false\ninstructions=false\n'],
  [['README.md', 'docs/plans/example.md'], 'code=false\ninstructions=false\n'],
  [['wolfstar-agent-kit/skills/pr/SKILL.md'], 'code=false\ninstructions=true\n'],
  [['wolfstar-agent-kit/evals/pr-ship-it/graders/criteria.md'], 'code=false\ninstructions=true\n'],
  [['agent-context/AGENTS.md', 'AGENTS.md'], 'code=false\ninstructions=true\n'],
  [['.github/PULL_REQUEST_TEMPLATE.md'], 'code=false\ninstructions=true\n'],
  [['docs/agent-terminal.md'], 'code=false\ninstructions=true\n'],
  [['docs/plans/AGENTS.md'], 'code=false\ninstructions=true\n'],
  [['packages/wolfstar-github-agent/src/agent-context.ts'], 'code=true\ninstructions=true\n'],
  [['README.md', 'package.json'], 'code=true\ninstructions=true\n'],
  [['docs/plans/file\nwith-newline.md'], 'code=false\ninstructions=false\n'],
])('selects checks for changed paths %j', (paths, expected) => {
  const output = execFileSync(process.execPath, ['--experimental-strip-types', script], {
    input: paths.length ? `${paths.join('\0')}\0` : '',
    encoding: 'utf8',
  })
  expect(output).toBe(expected)
})
