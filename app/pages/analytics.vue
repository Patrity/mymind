<script setup lang="ts">
import type { RangeKey } from '~~/shared/types/analytics'
import type { UsageRangeKey } from '~~/shared/types/usage'
definePageMeta({ title: 'Analytics' })

const { useSnapshot, useUsage, useDispatches } = useAnalytics()

const tab = ref<'infra' | 'usage'>('infra')
const tabItems = [
  { label: 'Infrastructure', value: 'infra' },
  { label: 'Usage', value: 'usage' },
]

const range = ref<RangeKey>('1h')
const rangeItems = [
  { label: '1h', value: '1h' }, { label: '6h', value: '6h' },
  { label: '24h', value: '24h' }, { label: '7d', value: '7d' },
]
const { data: snapshot, error: snapshotError } = useSnapshot()

const usageRange = ref<UsageRangeKey>('30d')
const usageRangeItems = [
  { label: '7d', value: '7d' }, { label: '30d', value: '30d' },
  { label: '90d', value: '90d' }, { label: 'All', value: 'all' },
]
const { data: usage, isPending: usagePending } = useUsage(usageRange)
const { data: dispatches } = useDispatches(usageRange)

// Hash-coloured in the child components by name, not by this order — kept alphabetical
// here only so the stack order in UsageStackedChart doesn't reshuffle on every fetch
// (byModel itself is sorted by valueUsd desc, which changes per range).
const usageModels = computed(() => [...(usage.value?.byModel.map(r => r.model) ?? [])].sort())

// Unpriced models (valueUsd === null) are excluded here, not zero-valued — mixing them
// in would misrepresent "no price data" as "worth $0" in the breakdown bars.
const valueByModelRows = computed(() => (usage.value?.byModel ?? [])
  .filter(r => r.valueUsd != null)
  .map(r => ({ label: r.model, value: r.valueUsd as number })))

const dispatchRows = computed(() => (dispatches.value?.bySubagent ?? [])
  .map(r => ({ label: r.subagentType, value: r.count })))

const currency = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)

// LiteLLM is the one line item on this page that's real money (subscription-billed
// Claude Code usage above is API-equivalent value, never billed directly) — summed
// separately here and rendered as its own visually distinct panel; never added to
// usage.totals.valueUsd.
const litellmTotalSpend = computed(() => (usage.value?.litellm ?? []).reduce((s, d) => s + d.spendUsd, 0))
const litellmTotalTokens = computed(() => (usage.value?.litellm ?? []).reduce((s, d) => s + d.tokens, 0))
</script>

<template>
  <UDashboardPanel id="analytics" grow>
    <template #header>
      <UDashboardNavbar title="Analytics">
        <template #leading><UDashboardSidebarCollapse /></template>
        <template #right>
          <UTabs v-model="tab" :items="tabItems" size="xs" :content="false" />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <div v-if="tab === 'infra'" class="space-y-6 p-4">
        <UTabs v-model="range" :items="rangeItems" size="xs" :content="false" />
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
        <AnalyticsRequestLogTable />
      </div>
      <div v-else class="space-y-6 p-4">
        <UTabs v-model="usageRange" :items="usageRangeItems" size="xs" :content="false" />
        <AnalyticsUsageTiles :usage="usage" :pending="usagePending" />
        <AnalyticsUsageStackedChart :daily="usage?.daily ?? []" :models="usageModels" />
        <div class="grid gap-4 lg:grid-cols-2">
          <AnalyticsUsageBreakdownBars title="Where the value went" :rows="valueByModelRows" :format="currency" />
          <AnalyticsUsageBreakdownBars title="Fleet composition" :rows="dispatchRows" />
        </div>
        <UCard :ui="{ root: 'ring-2 ring-warning/50', body: 'p-3 sm:p-4' }">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div class="flex items-center gap-2">
                <span class="text-base font-semibold text-highlighted">LiteLLM spend</span>
                <UBadge color="warning" variant="solid" size="sm">Actual spend</UBadge>
              </div>
              <p class="mt-1 max-w-md text-xs text-muted">
                Real dollars billed through LiteLLM — not comparable to the API-equivalent
                value above, and never summed with it.
              </p>
            </div>
            <div class="text-right">
              <div class="text-2xl font-bold text-warning">{{ usagePending ? '—' : currency(litellmTotalSpend) }}</div>
              <div class="text-xs text-muted">{{ litellmTotalTokens.toLocaleString() }} tokens billed</div>
            </div>
          </div>
        </UCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
