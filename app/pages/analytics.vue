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
        <div class="grid gap-4 lg:grid-cols-2">
          <AnalyticsTimeSeriesChart panel="gpu-util" :range="range" title="GPU utilization" unit="%" />
          <AnalyticsTimeSeriesChart panel="gpu-vram" :range="range" title="GPU VRAM" :format="(v) => (v / 1024 ** 3).toFixed(1) + ' GB'" />
          <AnalyticsTimeSeriesChart panel="gpu-power" :range="range" title="GPU power" unit=" W" />
          <AnalyticsTimeSeriesChart panel="gpu-temp" :range="range" title="GPU temperature" unit="°C" />
          <AnalyticsTimeSeriesChart panel="vllm-requests" :range="range" title="vLLM requests" />
          <AnalyticsTimeSeriesChart panel="vllm-throughput" :range="range" title="vLLM token throughput" unit=" tok/s" />
          <AnalyticsTimeSeriesChart panel="vllm-ttft" :range="range" title="Time to first token" unit=" ms" />
          <AnalyticsTimeSeriesChart panel="vllm-kv-cache" :range="range" title="KV-cache usage" unit="%" />
          <AnalyticsTimeSeriesChart panel="litellm-requests" :range="range" title="LiteLLM requests" />
          <AnalyticsTimeSeriesChart panel="litellm-tokens" :range="range" title="LiteLLM tokens" />
          <AnalyticsTimeSeriesChart panel="litellm-spend" :range="range" title="LiteLLM spend" :format="(v) => '$' + v.toFixed(4)" />
          <AnalyticsTimeSeriesChart panel="tei-rate" :range="range" title="Embedding rate" unit="/min" />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
