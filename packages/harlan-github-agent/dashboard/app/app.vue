<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>

    <SkewNotification v-slot="{ isOpen, dismiss, reload }">
      <Transition
        enter-active-class="transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="translate-y-2 opacity-0"
        leave-active-class="transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none"
        leave-to-class="translate-y-2 opacity-0"
      >
        <section
          v-if="isOpen"
          class="fixed right-3 bottom-3 z-50 flex max-w-[calc(100vw-1.5rem)] items-center gap-1.5 rounded-full border border-default bg-elevated p-2 shadow-xl sm:right-4 sm:bottom-4"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <strong class="whitespace-nowrap pr-1 pl-2 text-sm font-semibold text-highlighted">Update available</strong>
          <UButton class="min-h-11 rounded-full" size="sm" label="Reload dashboard" @click="reload" />
          <UButton
            class="size-11 shrink-0 rounded-full p-0"
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-octicon-x-16"
            aria-label="Close update notice"
            @click="dismiss"
          />
        </section>
      </Transition>
    </SkewNotification>
  </UApp>
</template>
