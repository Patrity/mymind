<!-- app/pages/settings.vue -->
<script setup lang="ts">
const route = useRoute()
// Child pages set definePageMeta({ title }); meta merges child-over-parent.
const title = computed(() => {
  const t = route.meta.title as string | undefined
  return t ? `Settings · ${t}` : 'Settings'
})
</script>

<template>
  <UDashboardPanel id="settings">
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
