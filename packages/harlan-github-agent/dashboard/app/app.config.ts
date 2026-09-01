/**
 * Component rules from DESIGN.md, expressed as Nuxt UI slot and variant overrides.
 *
 * Primary resolves to ink through `--ui-primary` in main.css, so `color="primary"`
 * and `color="neutral"` render the same way on purpose. Semantic colour is a
 * signal on badges, dots, and one alert row, never a fill.
 */
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'neutral',
      neutral: 'neutral',
    },
    // Nuxt UI's own slots resolve to Octicons, so no Lucide glyph ever renders.
    icons: {
      arrowDown: 'i-octicon-arrow-down-16',
      arrowLeft: 'i-octicon-arrow-left-16',
      arrowRight: 'i-octicon-arrow-right-16',
      arrowUp: 'i-octicon-arrow-up-16',
      caution: 'i-octicon-alert-16',
      check: 'i-octicon-check-16',
      chevronDoubleLeft: 'i-octicon-chevron-left-16',
      chevronDoubleRight: 'i-octicon-chevron-right-16',
      chevronDown: 'i-octicon-chevron-down-16',
      chevronLeft: 'i-octicon-chevron-left-16',
      chevronRight: 'i-octicon-chevron-right-16',
      chevronUp: 'i-octicon-chevron-up-16',
      close: 'i-octicon-x-16',
      copy: 'i-octicon-copy-16',
      copyCheck: 'i-octicon-check-16',
      dark: 'i-octicon-moon-16',
      drag: 'i-octicon-grabber-16',
      ellipsis: 'i-octicon-kebab-horizontal-16',
      error: 'i-octicon-x-circle-16',
      external: 'i-octicon-arrow-up-right-16',
      eye: 'i-octicon-eye-16',
      eyeOff: 'i-octicon-eye-closed-16',
      file: 'i-octicon-file-16',
      folder: 'i-octicon-file-directory-16',
      folderOpen: 'i-octicon-file-directory-open-fill-16',
      hash: 'i-octicon-hash-16',
      info: 'i-octicon-info-16',
      light: 'i-octicon-sun-16',
      loading: 'i-octicon-sync-16',
      menu: 'i-octicon-three-bars-16',
      minus: 'i-octicon-dash-16',
      panelClose: 'i-octicon-sidebar-collapse-16',
      panelOpen: 'i-octicon-sidebar-expand-16',
      plus: 'i-octicon-plus-16',
      reload: 'i-octicon-sync-16',
      search: 'i-octicon-search-16',
      stop: 'i-octicon-square-fill-16',
      star: 'i-octicon-star-16',
      success: 'i-octicon-check-circle-16',
      system: 'i-octicon-device-desktop-16',
      tip: 'i-octicon-light-bulb-16',
      upload: 'i-octicon-upload-16',
      warning: 'i-octicon-alert-16',
    },
    button: {
      slots: {
        base: 'font-medium rounded-md transition-colors',
        leadingIcon: 'size-4',
        trailingIcon: 'size-4',
      },
      variants: {
        size: {
          xs: { base: 'px-2 py-1 text-sm/5 gap-1', leadingIcon: 'size-4', trailingIcon: 'size-4' },
          sm: { base: 'px-2.5 py-1.5 text-sm/5 gap-1.5', leadingIcon: 'size-4', trailingIcon: 'size-4' },
          md: { base: 'px-3 py-2.5 text-sm/5 gap-1.5', leadingIcon: 'size-4', trailingIcon: 'size-4' },
          lg: { base: 'px-3.5 py-3 text-sm/5 gap-2', leadingIcon: 'size-4', trailingIcon: 'size-4' },
          xl: { base: 'px-4 py-3 text-sm/5 gap-2', leadingIcon: 'size-4', trailingIcon: 'size-4' },
        },
      },
      compoundVariants: [
        { color: 'primary', variant: 'solid', class: 'text-inverted bg-primary hover:bg-primary/85 active:bg-primary/85 disabled:bg-primary aria-disabled:bg-primary' },
        { color: 'primary', variant: 'outline', class: 'ring ring-inset ring-accented text-default bg-transparent hover:bg-muted active:bg-muted disabled:bg-transparent aria-disabled:bg-transparent focus-visible:ring-accented' },
        { color: 'primary', variant: 'ghost', class: 'text-default hover:bg-muted active:bg-muted' },
        { color: 'neutral', variant: 'outline', class: 'ring ring-inset ring-accented text-default bg-transparent hover:bg-muted active:bg-muted disabled:bg-transparent aria-disabled:bg-transparent focus-visible:ring-accented' },
        { color: 'neutral', variant: 'ghost', class: 'text-default hover:bg-muted active:bg-muted' },
        { color: 'success', variant: 'outline', class: 'status-success ring-success/40 hover:bg-success/10' },
        { color: 'warning', variant: 'outline', class: 'status-warning ring-warning/40 hover:bg-warning/10' },
        { color: 'error', variant: 'outline', class: 'status-error ring-error/40 hover:bg-error/10' },
        { color: 'success', variant: 'ghost', class: 'status-success hover:bg-success/10' },
        { color: 'warning', variant: 'ghost', class: 'status-warning hover:bg-warning/10' },
        { color: 'error', variant: 'ghost', class: 'status-error hover:bg-error/10' },
        // Icon-only triggers keep the same heights as their labelled siblings.
        { size: 'xs', square: true, class: 'p-1.5' },
        { size: 'sm', square: true, class: 'p-2' },
        { size: 'md', square: true, class: 'p-3' },
        { size: 'lg', square: true, class: 'p-3.5' },
        { size: 'xl', square: true, class: 'p-3.5' },
      ],
      defaultVariants: {
        color: 'primary',
        variant: 'solid',
        size: 'sm',
      },
    },
    badge: {
      slots: {
        base: 'font-medium',
      },
      variants: {
        size: {
          sm: { base: 'text-sm/4 px-1.5 py-0.5 gap-1 rounded-sm', leadingIcon: 'size-3.5', trailingIcon: 'size-3.5' },
          md: { base: 'text-sm/5 px-2 py-1 gap-1 rounded-sm', leadingIcon: 'size-3.5', trailingIcon: 'size-3.5' },
        },
      },
      compoundVariants: [
        { color: 'neutral', variant: 'outline', class: 'ring ring-inset ring-accented text-default bg-transparent' },
        { color: 'neutral', variant: 'subtle', class: 'ring ring-inset ring-default text-default bg-elevated' },
        { color: 'success', variant: 'outline', class: 'status-success ring-success/40' },
        { color: 'warning', variant: 'outline', class: 'status-warning ring-warning/40' },
        { color: 'error', variant: 'outline', class: 'status-error ring-error/40' },
        { color: 'success', variant: 'subtle', class: 'status-success ring-success/25' },
        { color: 'warning', variant: 'subtle', class: 'status-warning ring-warning/25' },
        { color: 'error', variant: 'subtle', class: 'status-error ring-error/25' },
        { color: 'success', variant: 'soft', class: 'status-success' },
        { color: 'warning', variant: 'soft', class: 'status-warning' },
        { color: 'error', variant: 'soft', class: 'status-error' },
      ],
      defaultVariants: {
        color: 'neutral',
        variant: 'outline',
        size: 'sm',
      },
    },
    card: {
      slots: {
        root: 'rounded-md transition-colors',
        header: 'p-3',
        body: 'p-3',
        footer: 'p-3',
        title: 'text-base font-medium text-highlighted',
        description: 'mt-0.5 text-sm text-muted',
      },
      variants: {
        variant: {
          outline: { root: 'bg-elevated ring ring-default divide-y divide-default hover:ring-accented' },
          soft: { root: 'bg-muted divide-y divide-default' },
          subtle: { root: 'bg-muted ring ring-default divide-y divide-default' },
        },
      },
      defaultVariants: {
        variant: 'outline',
      },
    },
    slideover: {
      slots: {
        overlay: 'fixed inset-0 bg-default/70',
        content: 'fixed bg-default divide-y divide-default flex flex-col focus:outline-none border-s border-default shadow-lg',
        header: 'flex items-center gap-1.5 px-5 py-3 min-h-12',
        body: 'flex-1 overflow-y-auto p-5',
        footer: 'flex items-center gap-2 px-5 py-3',
        title: 'text-base font-medium text-highlighted',
        description: 'mt-0.5 text-sm text-muted',
        close: 'absolute top-2 end-3',
      },
      variants: {
        side: {
          right: { content: 'max-w-[30rem]' },
          left: { content: 'max-w-[30rem]' },
        },
        transition: {
          true: {
            overlay: 'data-[state=open]:animate-[fade-in_200ms_ease-out] data-[state=closed]:animate-[fade-out_120ms_ease-out]',
          },
        },
      },
    },
    modal: {
      slots: {
        overlay: 'fixed inset-0 bg-default/70',
        content: 'bg-elevated divide-y divide-default flex flex-col focus:outline-none',
        header: 'flex items-center gap-1.5 px-5 py-3 min-h-12',
        body: 'flex-1 p-5 text-sm',
        footer: 'flex items-center justify-end gap-2 px-5 py-3',
        title: 'text-base font-medium text-highlighted',
        description: 'mt-0.5 text-sm text-muted',
        close: 'absolute top-2 end-3',
      },
      variants: {
        fullscreen: {
          false: { content: 'w-[calc(100vw-2rem)] max-w-md rounded-md ring ring-default shadow-lg' },
        },
      },
    },
    dropdownMenu: {
      slots: {
        content: 'bg-elevated ring ring-default rounded-md shadow-lg',
        label: 'field-label',
        item: 'rounded-sm',
      },
      variants: {
        size: {
          md: { label: 'px-2 py-1.5 gap-1.5', item: 'px-2 py-1.5 text-sm/5 gap-2', itemLeadingIcon: 'size-4', itemTrailingIcon: 'size-4' },
        },
      },
      compoundVariants: [
        { color: 'error', active: false, class: { item: 'status-error data-highlighted:before:bg-error/10', itemLeadingIcon: 'status-error' } },
      ],
      defaultVariants: {
        size: 'md',
      },
    },
    input: {
      slots: {
        base: 'rounded-md',
        leadingIcon: 'size-4',
        trailingIcon: 'size-4',
      },
      variants: {
        size: {
          sm: { base: 'px-2.5 py-1.5 text-sm/5 gap-1.5', leadingIcon: 'size-4', trailingIcon: 'size-4' },
          md: { base: 'px-3 py-2.5 text-sm/5 gap-1.5', leadingIcon: 'size-4', trailingIcon: 'size-4' },
        },
        variant: {
          outline: 'text-highlighted bg-elevated ring ring-inset ring-default',
        },
      },
      compoundVariants: [
        { color: 'primary', variant: 'outline', class: 'focus-visible:ring-2 focus-visible:ring-inverted' },
        { color: 'neutral', variant: 'outline', class: 'focus-visible:ring-2 focus-visible:ring-inverted' },
      ],
      defaultVariants: {
        size: 'md',
        variant: 'outline',
      },
    },
    table: {
      slots: {
        th: 'field-label px-3 py-2.5 text-start whitespace-nowrap',
        td: 'px-3 py-3 text-sm text-default whitespace-nowrap',
        tr: 'transition-colors hover:bg-muted',
        tbody: 'divide-y divide-default',
        separator: 'bg-border',
      },
    },
    tooltip: {
      slots: {
        content: 'bg-inverted text-inverted ring-0 shadow-none rounded-sm h-7 px-2 text-sm',

        arrow: 'fill-(--ui-bg-inverted) stroke-(--ui-bg-inverted)',
      },
    },
  },
})
