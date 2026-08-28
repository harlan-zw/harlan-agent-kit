export default defineNuxtConfig({
  compatibilityDate: '2026-08-13',
  pages: { pattern: ['**/*.vue', '!**/_*.vue'] },
  css: ['~/assets/css/main.css'],
  devtools: { enabled: true },
  modules: ['@nuxt/ui', '@nuxt/fonts', '@nuxt/icon', '@vueuse/nuxt'],
  fonts: {
    families: [
      { name: 'Geist', provider: 'google', weights: [400, 500, 600] },
      { name: 'Geist Mono', provider: 'google', weights: [400, 500] },
    ],
  },
  icon: {
    serverBundle: 'local',
    clientBundle: {
      scan: true,
      // WorkChip resolves these names at runtime. Static scanning cannot find them.
      icons: [
        'lucide:scan-eye',
        'lucide:wrench',
        'lucide:git-merge',
        'lucide:heart-pulse',
        'lucide:inbox',
        'lucide:hammer',
      ],
    },
  },
  ui: {
    theme: {
      colors: ['primary', 'success', 'warning', 'error', 'neutral'],
    },
  },
  nitro: {
    prerender: {
      routes: ['/', '/history', '/stats', '/watching', '/flow'],
    },
  },
})
