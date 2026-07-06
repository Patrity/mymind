<script setup lang="ts">
import type { ServiceHealth } from '~~/shared/types/analytics'
defineProps<{ services: ServiceHealth[] }>()
</script>

<template>
  <div class="flex flex-wrap gap-2">
    <UBadge
      v-for="s in services" :key="s.id" variant="subtle" size="lg"
      :color="s.up === true ? 'success' : s.up === false ? 'error' : 'neutral'"
      :icon="s.up === true ? 'i-lucide-circle-check' : s.up === false ? 'i-lucide-circle-x' : 'i-lucide-circle-help'"
    >
      {{ s.label }}
    </UBadge>
  </div>
</template>
