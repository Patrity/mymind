<script setup lang="ts">
const props = withDefaults(defineProps<{
  title?: string
}>(), {
  title: 'Details'
})
</script>

<template>
  <details class="group my-3 rounded-lg border border-default bg-muted/30">
    <summary
      class="flex cursor-pointer select-none list-none items-center gap-2 px-4 py-2.5 text-sm font-medium text-default hover:bg-elevated/40 transition-colors rounded-lg"
    >
      <UIcon
        name="i-lucide-chevron-right"
        class="size-3.5 transition-transform group-open:rotate-90"
      />
      {{ title }}
    </summary>
    <div class="px-4 pb-3 pt-1 text-sm leading-relaxed text-muted">
      <slot />
    </div>
  </details>
</template>
