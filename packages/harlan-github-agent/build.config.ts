import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: [
        './src/index.ts',
        './src/cli.ts',
        './src/desktop-client.ts',
        './src/desktop-execute.ts',
        './src/agent-sandbox-cli.ts',
        './src/agent-sandbox-runtime.ts',
        './src/github-media-render.ts',
        './src/repair-regression-reporter.ts',
        './src/review-mcp.ts',
        './src/review-evidence-cli.ts',
      ],
    },
  ],
})
