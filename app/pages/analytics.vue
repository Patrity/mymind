<script setup lang="ts">
import type { RangeKey } from '~~/shared/types/analytics'
definePageMeta({ title: 'Analytics' })

const { useSnapshot } = useAnalytics()
const range = ref<RangeKey>('1h')
const rangeItems = [
  { label: '1h', value: '1h' }, { label: '6h', value: '6h' },
  { label: '24h', value: '24h' }, { label: '7d', value: '7d' },
]
const { data: snapshot, error: snapshotError } = useSnapshot()
</script>

<template>
  <UDashboardPanel id="analytics" grow>
    <template #header>
      <UDashboardNavbar title="Analytics">
        <template #leading><UDashboardSidebarCollapse /></template>
        <template #right>
          <UTabs v-model="range" :items="rangeItems" size="xs" :content="false" />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <div class="space-y-6 p-4">
        <UAlert v-if="snapshotError" color="error" variant="subtle" title="Prometheus unreachable"
                :description="(snapshotError as any)?.data?.statusMessage ?? 'Check Settings → Analytics'" />
        <AnalyticsHealthStrip v-if="snapshot" :services="snapshot.services" />
        <AnalyticsGpuTiles v-if="snapshot" :gpus="snapshot.gpus" />
        <!-- Task 9 replaces these placeholders with TimeSeriesChart panels -->
        <div class="grid gap-4 lg:grid-cols-2">
          <USkeleton class="h-56" /><USkeleton class="h-56" />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
