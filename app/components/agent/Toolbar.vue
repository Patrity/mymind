<!-- app/components/agent/Toolbar.vue -->
<script setup lang="ts">
defineProps<{ title: string | null }>()
const emit = defineEmits<{ fullBleed: []; threads: [] }>()
</script>

<template>
  <UDashboardNavbar :title="title || 'Bridget'">
    <template #leading>
      <UDashboardSidebarCollapse />
      <!-- Below lg the thread rail is hidden, so it is reached from here instead. -->
      <UButton
        icon="i-lucide-panel-left"
        variant="ghost"
        color="neutral"
        class="lg:hidden"
        aria-label="Conversations"
        @click="emit('threads')"
      />
    </template>
    <template #right>
      <UButton
        icon="i-lucide-maximize-2"
        variant="ghost"
        color="neutral"
        aria-label="Full-screen voice mode"
        @click="emit('fullBleed')"
      />
      <!-- Voice settings live here as a self-contained slideover (it owns its own
           cog trigger), passed in by the page so this component stays voice-agnostic. -->
      <slot name="actions" />
    </template>
  </UDashboardNavbar>
</template>
