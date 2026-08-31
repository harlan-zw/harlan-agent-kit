import antfu from '@antfu/eslint-config'
import harlanzw from 'eslint-plugin-harlanzw'

export default antfu(
  {
    typescript: true,
    // Vue lives in packages/harlan-github-agent, not the root, so auto-detection
    // misses it and every dashboard .vue file falls back to the plain TS parser.
    vue: true,
  },
  {
    files: [
      '.github/gen.mjs',
      'harlan-agent-kit/skills/tweet/templates/*.mjs',
    ],
    rules: {
      'antfu/no-top-level-await': 'off',
      'no-console': 'off',
    },
  },
  ...harlanzw({ base: true }),
)
