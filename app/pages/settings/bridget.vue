<!-- app/pages/settings/bridget.vue -->
<script setup lang="ts">
definePageMeta({ title: 'Bridget' })
</script>

<template>
  <div class="flex flex-col gap-8">
    <SettingsPersonaTab />
    <div class="border-t border-default pt-6">
      <SettingsAgentTimezone />
    </div>
  </div>
</template>
