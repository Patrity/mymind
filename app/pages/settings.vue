<!-- app/pages/settings.vue -->
<script setup lang="ts">
const route = useRoute()
// Child pages set definePageMeta({ title }); meta merges child-over-parent.
const title = computed(() => {
  const t = route.meta.title as string | undefined
  return t ? `Settings · ${t}` : 'Settings'
})
// A child that brings its own UDashboardPanel(s) — a full-height editor (Profile) or a
// multi-column studio (Voice) — sets definePageMeta({ settingsPanel: false }) and renders bare,
// instead of inside this padded, scrolling panel body.
const ownPanel = computed(() => route.meta.settingsPanel === false)
</script>

<template>
  <NuxtPage v-if="ownPanel" />
  <UDashboardPanel
    v-else
    id="settings"
  >
    <template #header>
      <UDashboardNavbar :title="title">
        <template #leading><UDashboardSidebarCollapse /></template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <div class="p-4 sm:p-6">
        <NuxtPage />
      </div>
    </template>
  </UDashboardPanel>
</template>
