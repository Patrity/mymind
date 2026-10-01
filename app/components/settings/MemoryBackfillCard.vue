<!-- app/components/settings/MemoryBackfillCard.vue
  Start / Pause for the cycle-77 dual-score backfill (GET/PUT /api/memories/backfill). Progress
  is live: the service publishes `memoryBackfill`, which invalidates ['memory-backfill']. -->
<script setup lang="ts">
import { $fetch as ofetch } from 'ofetch'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { BackfillProgress } from '~~/server/services/memory-backfill'

const qc = useQueryClient()
const toast = useToast()

const { data: progress, error } = useQuery({
  queryKey: ['memory-backfill'],
  queryFn: () => ofetch<BackfillProgress>('/api/memories/backfill')
})

watch(error, (err) => {
  if (!err) return
  const e = err as { data?: { statusMessage?: string }, message?: string }
  toast.add({ color: 'error', title: 'Failed to load backfill progress', description: e.data?.statusMessage ?? e.message })
})

const saving = ref(false)
async function setState(state: 'running' | 'off') {
  saving.value = true
  try {
    const fresh = await ofetch<BackfillProgress>('/api/memories/backfill', { method: 'PUT', body: { state } })
    qc.setQueryData(['memory-backfill'], fresh)
  } catch (err) {
    const e = err as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: state === 'running' ? 'Could not start the backfill' : 'Could not pause the backfill', description: e.data?.statusMessage ?? e.message })
  } finally {
    saving.value = false
  }
}

/** Both parts count: (jevDone + auditDone) / (2 × total), as a percent. */
const percent = computed(() => {
  const p = progress.value
  if (!p || p.total === 0) return 0
  return Math.round(((p.jevDone + p.auditDone) / (2 * p.total)) * 100)
})

const stateBadge = computed(() => {
  const s = progress.value?.state
  if (s === 'running') return { label: 'running', color: 'success' as const }
  if (s === 'done') return { label: 'done', color: 'info' as const }
  return { label: 'paused', color: 'neutral' as const }
})

const eta = computed(() => {
  const m = progress.value?.etaMinutes
  if (m == null) return null
  if (m < 1) return 'under a minute'
  if (m < 90) return `~${Math.round(m)} min`
  return `~${(m / 60).toFixed(1)} h`
})
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <div>
          <h2 class="text-base font-semibold text-highlighted">Score backfill</h2>
          <p class="text-sm text-muted">Scores existing memories with Jev and the extract-v3 audit. No memory is changed.</p>
        </div>
        <UBadge
          v-if="progress"
          :label="stateBadge.label"
          :color="stateBadge.color"
          variant="subtle"
        />
      </div>
    </template>

    <div v-if="progress" class="flex flex-col gap-4">
      <UProgress :model-value="percent" :max="100" status />

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div><p class="text-xs text-muted">Jev scored</p><p class="text-highlighted font-medium">{{ progress.jevDone }} / {{ progress.total }}</p></div>
        <div><p class="text-xs text-muted">Audited</p><p class="text-highlighted font-medium">{{ progress.auditDone }} / {{ progress.total }}</p></div>
        <div><p class="text-xs text-muted">Remaining</p><p class="text-highlighted font-medium">{{ progress.remaining }}</p></div>
        <div><p class="text-xs text-muted">Skipped (3 failures)</p><p class="text-highlighted font-medium">{{ progress.skipped }}</p></div>
      </div>

      <p v-if="progress.state === 'done'" class="text-sm text-success">
        All memories scored
      </p>
      <p v-else class="text-xs text-muted">
        ETA: {{ eta ?? '—' }}
      </p>

      <UAlert
        v-if="progress.lastError"
        color="error"
        variant="subtle"
        icon="i-lucide-alert-circle"
        title="Last error"
        :description="progress.lastError"
      />
    </div>
    <USkeleton v-else class="h-24 w-full" />

    <template #footer>
      <div class="flex items-center gap-3">
        <!-- `done` is set only by the backfill itself; Re-run is the same PUT `running`, which
             picks up anything new or still missing (e.g. after an audit prompt bump). -->
        <UButton
          v-if="progress?.state === 'done'"
          label="Re-run"
          icon="i-lucide-rotate-cw"
          color="primary"
          :loading="saving"
          @click="setState('running')"
        />
        <UButton
          v-else-if="progress?.state !== 'running'"
          label="Start"
          icon="i-lucide-play"
          color="primary"
          :loading="saving"
          :disabled="!progress"
          @click="setState('running')"
        />
        <UButton
          v-else
          label="Pause"
          icon="i-lucide-pause"
          color="neutral"
          variant="outline"
          :loading="saving"
          @click="setState('off')"
        />
        <p class="text-xs text-dimmed">40 memories every 5 minutes while running.</p>
      </div>
    </template>
  </UCard>
</template>
