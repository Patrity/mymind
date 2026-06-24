<!-- app/pages/settings.vue -->
<script setup lang="ts">
definePageMeta({ title: 'Settings' })
const tabs = [
  { label: 'Providers', icon: 'i-lucide-server', slot: 'providers' as const },
  { label: 'Models', icon: 'i-lucide-box', slot: 'models' as const },
  { label: 'Model Configuration', icon: 'i-lucide-sliders-horizontal', slot: 'assignments' as const },
  { label: 'API Keys', icon: 'i-lucide-key-round', slot: 'apikeys' as const },
  { label: 'Activity & Alerts', icon: 'i-lucide-activity', slot: 'activity' as const },
  { label: 'Bridget', icon: 'i-lucide-bot', slot: 'bridget' as const },
  { label: 'Search', icon: 'i-lucide-search', slot: 'search' as const },
  { label: 'Agent Tools', icon: 'i-lucide-terminal', slot: 'agentTools' as const },
  { label: 'Secrets', icon: 'i-lucide-key-square', slot: 'secrets' as const },
  { label: 'Image Gen', icon: 'i-lucide-image', slot: 'imageGen' as const }
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
      <div class="p-4 sm:p-6">
        <UTabs :items="tabs" class="w-full">
          <template #providers><SettingsProvidersTab /></template>
          <template #models><SettingsModelsTab /></template>
          <template #assignments><SettingsAssignmentsTab /></template>
          <template #apikeys><SettingsApiKeysTab /></template>
          <template #activity><SettingsActivityAlertsTab /></template>
          <template #bridget><SettingsPersonaTab /></template>
          <template #search><SettingsSearchTab /></template>
          <template #agentTools><SettingsAgentToolsTab /></template>
          <template #secrets><SettingsSecretsTab /></template>
          <template #imageGen><SettingsImageGenTab /></template>
        </UTabs>
      </div>
    </template>
  </UDashboardPanel>
</template>
