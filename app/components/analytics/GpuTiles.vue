<script setup lang="ts">
import type { GpuSnapshot } from '~~/shared/types/analytics'
defineProps<{ gpus: GpuSnapshot[] }>()
const gb = (b: number | null) => b == null ? '—' : (b / 1024 ** 3).toFixed(1)
</script>

<template>
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
    <UCard v-for="g in gpus" :key="g.uuid" :ui="{ body: 'p-3 sm:p-4' }">
      <div class="text-sm font-medium text-highlighted truncate">{{ g.label }}</div>
      <div class="mt-2 flex items-baseline justify-between">
        <span class="text-2xl font-semibold">{{ g.utilPct == null ? '—' : Math.round(g.utilPct) + '%' }}</span>
        <span class="text-xs text-muted">{{ g.tempC == null ? '—' : g.tempC + '°C' }} · {{ g.powerW == null ? '—' : Math.round(g.powerW) + 'W' }}</span>
      </div>
      <UProgress class="mt-2" :model-value="g.utilPct ?? 0" size="sm" />
      <div class="mt-2 text-xs text-muted">VRAM {{ gb(g.vramUsedBytes) }} / {{ gb(g.vramTotalBytes) }} GB</div>
      <UProgress
        class="mt-1" size="sm" color="neutral"
        :model-value="g.vramUsedBytes != null && g.vramTotalBytes ? (g.vramUsedBytes / g.vramTotalBytes) * 100 : 0"
      />
    </UCard>
  </div>
</template>
