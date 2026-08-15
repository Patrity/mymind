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
// Gated to the Usage tab — an Infrastructure-only visit should not pay for this aggregation.
// (measured on prod at range=30d: 86ms and a 22MB external-merge spill). Deliberately no
// `staleTime` here, unlike the canonical `useUsage('all')` fetch below — these are range-scoped
// and should stay fresh whenever the user is actually looking at the Usage tab.
const usageTabActive = computed(() => tab.value === 'usage')
const { data: usage, isPending: usagePending } = useUsage(usageRange, { enabled: usageTabActive })
const { data: dispatches } = useDispatches(usageRange, { enabled: usageTabActive })

// Hash-coloured in the child components by name, not by this order — kept alphabetical
// here only so the stack order in UsageStackedChart doesn't reshuffle on every fetch
// (byModel itself is sorted by valueUsd desc, which changes per range).
const usageModels = computed(() => [...(usage.value?.byModel.map(r => r.model) ?? [])].sort())

// Colour-slot resolution input is deliberately NOT `usageModels` above — that's
// scoped to whatever range is currently selected, and the resolve algorithm's
// linear-probe fallback (see resolveColorSlots) can land a collision-victim model
// on a different slot depending on which OTHER models are competing for it. If the
// resolution input reshuffled with `usageRange` (e.g. 9 models at "all" vs. 4 at
// "90d"), a model's colour could silently reshuffle across a range switch too — the
// exact failure mode this fix exists to prevent, just moved from "per panel" to
// "per range". The "all" range's model list is a fixed, range-independent universe
// (ranges are nested time windows — 7d ⊆ 30d ⊆ 90d ⊆ all — so "all"'s model set is
// always a superset of every other range's).
//
// That query is also the single most expensive thing this endpoint serves — no
// `created_at` lower bound, so it's an unbounded full-history aggregation that grows
// with the corpus (see server/services/usage.ts). Two guards keep it from being a
// tax on every page load:
//  - `enabled: usageTabActive` gates it to the Usage tab, same as the range-scoped
//    `useUsage`/`useDispatches` calls above — all three composables run unconditionally
//    in <script setup> (Vue composables can't be called conditionally), so without
//    this an Infrastructure-only visit would still fire it — the `v-if="tab === 'usage'"`
//    in the template only gates rendering, not the fetch itself.
//  - `staleTime` of 30 minutes: the model roster changes about as often as
//    Anthropic ships a model, so refetching it on every tab switch/navigation is
//    pure waste. Deliberately NOT applied to the two range-scoped fetches above —
//    those should stay fresh whenever the user is actually looking at them.
const { data: usageAll } = useUsage('all', {
  enabled: usageTabActive,
  staleTime: 30 * 60 * 1000,
})
const canonicalModels = computed(() => [...(usageAll.value?.byModel.map(r => r.model) ?? [])].sort())

// Model -> palette slot, resolved ONCE here (over `canonicalModels`, not any single
// panel's or range's rendered subset) and passed to both UsageStackedChart and the
// "Where the value went" breakdown bars, so a given model renders in the same
// colour in both places AND stays on that colour across a range switch. Two
// independent resolutions over different subsets are NOT guaranteed to agree —
// dropping a label from the input can free its slot for a different, later-sorted
// label — so this must be computed once, over a stable input, and shared rather
// than recomputed per panel/range from whatever subset happens to be visible.
// PALETTE_SIZE must match CATEGORICAL_LIGHT/DARK's length in both chart components
// (their palette itself isn't duplicated here — only this integer needs to agree).
const MODEL_PALETTE_SIZE = 8

function hashIndex(key: string, mod: number): number {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0
  return Math.abs(h) % mod
}

function resolveColorSlots(labels: string[], mod: number): Record<string, number> {
  const slots: Record<string, number> = {}
  const used = new Set<number>()
  for (const label of [...labels].sort()) {
    let idx = hashIndex(label, mod)
    let attempts = 0
    while (used.has(idx) && attempts < mod) {
      idx = (idx + 1) % mod
      attempts++
    }
    used.add(idx)
    slots[label] = idx
  }
  return slots
}

// While the gated canonical fetch hasn't settled yet (tab just switched to Usage,
// or the 30-minute cache hasn't been warmed), `canonicalModels` is empty. Falling
// back to each visible model's raw hash slot — rather than an empty map, which
// would push every consumer onto ITS OWN self-resolution (see UsageStackedChart's
// and UsageBreakdownBars' `ownSlots` fallback) — means no flash for the common
// case: raw hash is exactly what resolveColorSlots starts from, so any model that
// isn't part of a collision keeps the identical slot once the real resolution
// lands. Only the rare, pigeonhole-forced colliding labels can still shift once,
// when the canonical set arrives.
const modelColorSlots = computed(() => {
  if (canonicalModels.value.length) return resolveColorSlots(canonicalModels.value, MODEL_PALETTE_SIZE)
  const raw: Record<string, number> = {}
  for (const m of usageModels.value) raw[m] = hashIndex(m, MODEL_PALETTE_SIZE)
  return raw
})

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
        <AnalyticsUsageStackedChart :daily="usage?.daily ?? []" :models="usageModels" :color-slots="modelColorSlots" />
        <div class="grid gap-4 lg:grid-cols-2">
          <AnalyticsUsageBreakdownBars title="Where the value went" :rows="valueByModelRows" :format="currency" :color-slots="modelColorSlots" />
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
