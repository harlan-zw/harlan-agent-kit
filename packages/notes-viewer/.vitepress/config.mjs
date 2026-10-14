import { MermaidMarkdown, MermaidPlugin } from 'vitepress-plugin-mermaid'

export default {
  title: 'Notes',
  description: 'Reports and diagrams',
  srcDir: '.content',
  cleanUrls: true,
  ignoreDeadLinks: true,
  markdown: { html: false, config: MermaidMarkdown },
  themeConfig: {
    search: { provider: 'local' },
    nav: [{ text: 'All notes', link: '/' }],
    outline: 'deep',
  },
  vite: {
    plugins: [MermaidPlugin({ securityLevel: 'strict' })],
    optimizeDeps: { include: ['mermaid'] },
    server: { strictPort: true, allowedHosts: ['notes.localhost'] },
    build: {
      // Each npm package becomes its own chunk, so the entry chunk shrinks
      // from 676 kB to a few vendor chunks that cache independently. Mermaid
      // is the exception: its hash-suffixed dist files are the lazy dynamic
      // entries for each diagram and layout, and re-homing them with
      // manualChunks merges them into one static chunk that loads on every
      // page, so only their static core becomes a chunk. Their ELK layout
      // still ships as one prebundled elkjs module of about 1.5 MB that
      // Rollup cannot split, which is why the warning limit sits at 1600.
      chunkSizeWarningLimit: 1600,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules') || id.endsWith('.css')) return
            const tail = id.split(/[/\\]node_modules[/\\]/).pop()
            if (/mermaid|elkjs/.test(tail.split('/')[0]) && /-[A-Z0-9]{8}\.mjs$/.test(tail)) return
            const name = tail.startsWith('@') ? tail.split('/').slice(0, 2).join('/') : tail.split('/')[0]
            return `vendor/${name.replace(/[^\w-]/g, '-')}`
          },
        },
      },
    },
  },
}
