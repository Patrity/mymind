<script setup lang="ts">
import { useTimeAgo } from '@vueuse/core'
import type { ActivityListParams, ActivityDTO } from '~~/shared/types/activity'

definePageMeta({ title: 'Activity' })
const toast = useToast()
const { useActivityList } = useActivityLog()

const paused = ref(false)
const kind = ref<string>('__all__')
const status = ref<string>('__all__')
const q = ref('')

const params = computed<ActivityListParams>(() => ({
  kind: kind.value === '__all__' ? undefined : (kind.value as ActivityDTO['kind']),
  status: status.value === '__all__' ? undefined : (status.value as ActivityDTO['status']),
  q: q.value.trim() || undefined,
  limit: 200
}))

const frozen = ref<ActivityListParams>(params.value)
watch(params, v => { if (!paused.value) frozen.value = v })
watch(paused, p => { if (!p) frozen.value = params.value })

const { data, isPending: loading, error } = useActivityList(() => paused.value ? frozen.value : params.value)
const rows = computed(() => data.value ?? [])

const displayed = ref<ActivityDTO[]>([])
watch(rows, (v) => { if (!paused.value) displayed.value = v }, { immediate: true })
watch(paused, (p) => { if (!p) displayed.value = rows.value })

watch(error, (err) => {
  if (!err) return
  const e = err as { data?: { statusMessage?: string }, message?: string }
  toast.add({ color: 'error', title: 'Failed to load activity', description: e.data?.statusMessage ?? e.message })
})

const kindItems = [{ label: 'All kinds', value: '__all__' }, ...['inbound', 'job', 'model', 'attempt', 'tool'].map(k => ({ label: k, value: k }))]
const statusItems = [{ label: 'All', value: '__all__' }, { label: 'OK', value: 'ok' }, { label: 'Warn', value: 'warn' }, { label: 'Error', value: 'error' }]

function statusColor(s: string): 'success' | 'warning' | 'error' | 'neutral' {
  return s === 'ok' ? 'success' : s === 'warn' ? 'warning' : s === 'error' ? 'error' : 'neutral'
}
function rel(iso: string) { return useTimeAgo(new Date(iso)).value }

async function ackAll() {
  await $fetch('/api/activity/ack-all', { method: 'POST' })
  toast.add({ color: 'success', title: 'All errors acknowledged' })
}
</script>

<template>
  <UDashboardPanel id="activity" grow :ui="{ body: '!p-0' }">
    <template #header>
      <UDashboardNavbar title="Activity">
        <template #leading><UDashboardSidebarCollapse /></template>
        <template #right>
          <UButton
            icon="i-lucide-check-check" label="Ack all" color="neutral" variant="ghost" size="sm"
            @click="ackAll"
          />
          <UButton
            :icon="paused ? 'i-lucide-play' : 'i-lucide-pause'"
            :label="paused ? 'Resume' : 'Pause'"
            color="neutral" variant="subtle" size="sm"
            @click="paused = !paused"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="p-4 space-y-4 max-w-5xl mx-auto w-full">
        <div class="flex flex-col sm:flex-row gap-3 flex-wrap">
          <UInput v-model="q" placeholder="Search by name…" icon="i-lucide-search" class="w-full sm:flex-1" />
          <USelect v-model="kind" :items="kindItems" value-key="value" class="w-40 shrink-0" />
          <USelect v-model="status" :items="statusItems" value-key="value" class="w-32 shrink-0" />
        </div>

        <div v-if="loading" class="space-y-2">
          <USkeleton v-for="i in 8" :key="i" class="h-14 w-full rounded-lg" />
        </div>

        <div v-else-if="!displayed.length" class="flex flex-col items-center justify-center py-24 gap-3 text-center">
          <UIcon name="i-lucide-activity" class="size-12 text-muted" />
          <p class="text-sm font-medium text-muted">No activity yet</p>
        </div>

        <template v-else>
          <UCard
            v-for="r in displayed" :key="r.id"
            class="cursor-pointer hover:bg-elevated/50 transition-colors"
            :ui="{ body: '!p-3' }"
            @click="navigateTo('/activity/' + r.id)"
          >
            <div class="flex items-center gap-3 flex-wrap">
              <UBadge :label="r.kind" color="neutral" variant="subtle" size="xs" />
              <UBadge :label="r.status" :color="statusColor(r.status)" variant="subtle" size="xs" />
              <span class="text-sm font-medium text-default truncate flex-1 min-w-0">{{ r.name }}</span>
              <span v-if="r.provider" class="text-xs text-dimmed hidden sm:inline">{{ r.provider }}</span>
              <span v-if="r.durationMs != null" class="text-xs text-dimmed">{{ r.durationMs }}ms</span>
              <span class="text-xs text-dimmed">{{ rel(r.createdAt) }}</span>
            </div>
            <p v-if="r.error" class="mt-1 text-xs text-error truncate">{{ (r.error as { message?: string }).message }}</p>
          </UCard>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
