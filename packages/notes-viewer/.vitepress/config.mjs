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
  vite: { plugins: [MermaidPlugin({ securityLevel: 'strict' })], optimizeDeps: { include: ['mermaid'] }, server: { strictPort: true, allowedHosts: ['notes.localhost'] } },
}
