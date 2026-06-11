<!-- app/pages/settings.vue -->
<script setup lang="ts">
definePageMeta({ title: 'Settings' })
const tabs = [
  { label: 'Providers', icon: 'i-lucide-server', slot: 'providers' as const },
  { label: 'Models', icon: 'i-lucide-box', slot: 'models' as const },
  { label: 'Model Configuration', icon: 'i-lucide-sliders-horizontal', slot: 'assignments' as const }
]
</script>

<template>
  <UDashboardPanel id="settings">
    <template #header>
      <UDashboardNavbar title="Settings">
        <template #leading><UDashboardSidebarCollapse /></template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <UTabs :items="tabs" class="w-full">
        <template #providers><SettingsProvidersTab /></template>
        <template #models><SettingsModelsTab /></template>
        <template #assignments><SettingsAssignmentsTab /></template>
      </UTabs>
    </template>
  </UDashboardPanel>
</template>
