import antfu from '@antfu/eslint-config'
import harlanzw from 'eslint-plugin-harlanzw'

export default antfu(
  {
    typescript: true,
    // Vue lives in packages/harlan-github-agent, not the root, so auto-detection
    // misses it and every dashboard .vue file falls back to the plain TS parser.
    vue: true,
  },
  ...harlanzw({ base: true }),
)
