export default defineAppConfig({
  ui: {
    colors: {
      primary: 'emerald',
      neutral: 'neutral',
    },
    button: {
      slots: {
        base: 'font-medium transition-colors duration-150',
      },
      defaultVariants: {
        color: 'primary',
        variant: 'solid',
      },
    },
    badge: {
      slots: {
        base: 'font-medium',
      },
      defaultVariants: {
        size: 'sm',
      },
    },
  },
})
