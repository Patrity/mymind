<script setup lang="ts">
import type { ActivityDTO } from '~~/shared/types/activity'

const route = useRoute()
const { useActivityDetail } = useActivityLog()
const { data, isPending } = useActivityDetail(() => route.params.id as string)

const tree = computed<(ActivityDTO & { depth: number })[]>(() => {
  const trace = data.value?.trace ?? []
  const byParent = new Map<string | null, ActivityDTO[]>()
  for (const r of trace) {
    const k = r.parentId
    if (!byParent.has(k)) byParent.set(k, [])
    byParent.get(k)!.push(r)
  }
  const out: (ActivityDTO & { depth: number })[] = []
  const ids = new Set(trace.map(r => r.id))
  const walk = (parent: string | null, depth: number) => {
    for (const r of byParent.get(parent) ?? []) { out.push({ ...r, depth }); walk(r.id, depth + 1) }
  }
  for (const r of trace) if (!r.parentId || !ids.has(r.parentId)) { out.push({ ...r, depth: 0 }); walk(r.id, 1) }
  return out.length ? out : trace.map(r => ({ ...r, depth: 0 }))
})

function statusColor(s: string): 'success' | 'warning' | 'error' | 'neutral' {
  return s === 'ok' ? 'success' : s === 'warn' ? 'warning' : s === 'error' ? 'error' : 'neutral'
}
function pretty(v: unknown) { return v == null ? '' : JSON.stringify(v, null, 2) }
const toast = useToast()
async function ack(id: string) {
  await $fetch(`/api/activity/${id}/ack`, { method: 'POST' })
  toast.add({ color: 'success', title: 'Acknowledged' })
}
</script>

<template>
  <UDashboardPanel id="activity-detail" grow>
    <template #header>
      <UDashboardNavbar title="Activity trace">
        <template #leading><UButton icon="i-lucide-arrow-left" variant="ghost" color="neutral" @click="navigateTo('/activity')" /></template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <div class="p-4 max-w-4xl mx-auto w-full space-y-3">
        <USkeleton v-if="isPending" class="h-40 w-full" />
        <template v-else>
          <UCard v-for="r in tree" :key="r.id" :ui="{ body: '!p-3' }">
            <div class="flex items-center gap-2 flex-wrap" :style="{ paddingLeft: `${r.depth * 16}px` }">
              <UBadge :label="r.kind" color="neutral" variant="subtle" size="xs" />
              <UBadge :label="r.status" :color="statusColor(r.status)" variant="subtle" size="xs" />
              <span class="text-sm font-medium">{{ r.name }}</span>
              <span v-if="r.durationMs != null" class="text-xs text-dimmed">{{ r.durationMs }}ms</span>
              <UButton v-if="r.status === 'error' && !r.ackedAt" label="Ack" size="xs" color="neutral" variant="ghost" class="ml-auto" @click="ack(r.id)" />
            </div>
            <div v-if="r.error" class="mt-2 text-xs text-error"><pre class="whitespace-pre-wrap">{{ pretty(r.error) }}</pre></div>
            <details v-if="r.request" class="mt-2"><summary class="text-xs text-muted cursor-pointer">request</summary><pre class="text-xs whitespace-pre-wrap mt-1 text-dimmed">{{ pretty(r.request) }}</pre></details>
            <details v-if="r.response" class="mt-1"><summary class="text-xs text-muted cursor-pointer">response</summary><pre class="text-xs whitespace-pre-wrap mt-1 text-dimmed">{{ pretty(r.response) }}</pre></details>
            <details v-if="Object.keys(r.meta || {}).length" class="mt-1"><summary class="text-xs text-muted cursor-pointer">meta</summary><pre class="text-xs whitespace-pre-wrap mt-1 text-dimmed">{{ pretty(r.meta) }}</pre></details>
          </UCard>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
