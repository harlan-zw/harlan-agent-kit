import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [{
    type: 'bundle',
    input: ['./src/index.ts', './src/cli.ts', './src/config.ts', './src/server.ts', './src/github.ts', './src/review.ts', './src/providers.ts'],
  }],
})
