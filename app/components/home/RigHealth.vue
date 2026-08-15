<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { SnapshotResponse } from '~~/shared/types/analytics'

const { data, error } = useQuery({
  queryKey: ['analytics', 'snapshot'],
  queryFn: () => $fetch<SnapshotResponse>('/api/analytics/snapshot'),
  // Home must not go red because the homelab is off. Fail quietly into one tile.
  retry: false
})

const services = computed(() => data.value?.services ?? [])
// `up === null` is "no data", deliberately excluded from the down count.
const down = computed(() => services.value.filter(s => s.up === false).length)

const colorFor = (up: boolean | null) => up === false ? 'error' as const
  : up === true ? 'success' as const
  : 'neutral' as const
const glyphFor = (up: boolean | null) => up === false ? '✕' : up === true ? '✓' : '–'
</script>

<template>
  <ULink
    to="/analytics"
    class="shrink-0 min-w-36 sm:min-w-0 rounded-lg border border-default bg-elevated/40 p-3 hover:bg-elevated transition-colors"
  >
    <p class="text-xs text-muted uppercase tracking-wide mb-1">Rig</p>
    <p v-if="error" class="text-xs text-dimmed">Unavailable</p>
    <div v-else class="flex flex-wrap gap-1">
      <UBadge
        v-for="s in services"
        :key="s.id"
        :color="colorFor(s.up)"
        variant="subtle"
        size="sm"
        :label="glyphFor(s.up)"
        :title="s.label"
      />
    </div>
    <p v-if="!error && down > 0" class="text-xs text-error mt-1">{{ down }} down</p>
  </ULink>
</template>
