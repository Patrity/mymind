<!-- app/components/agent/ConfinedChip.vue -->
<!-- Cycle 86 (spec D6): this tool call's command ran under sandbox-exec (taint confinement, or an eval
     world). The note is MyMind's own text — plain interpolation only. -->
<script setup lang="ts">
import type { ConfinementView } from '~/lib/agent/confinement'

defineProps<{ confinement: ConfinementView }>()
</script>

<template>
  <div
    class="-mt-2 mb-3 flex"
    data-testid="confined-chip"
    :data-reason="confinement.reason"
  >
    <UTooltip
      :text="confinement.note || confinement.label"
      :content="{ side: 'bottom', align: 'start' }"
    >
      <UBadge
        color="info"
        variant="soft"
        size="sm"
        icon="i-lucide-shield-half"
        :label="confinement.label"
      />
    </UTooltip>
  </div>
</template>
