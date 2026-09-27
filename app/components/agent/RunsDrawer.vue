<!-- app/components/agent/RunsDrawer.vue -->
<script setup lang="ts">
// Runs drawer: the raw agent_runs history for one thread, newest first. Read-only — there is
// no action here (Stop/steer already live in the composer) — this is for seeing what ran,
// when, and whether a wake was suppressed.
import { useQuery } from '@tanstack/vue-query'
import { useTimeAgo } from '@vueuse/core'
import type { RunStatus, RunTrigger, RunProfile } from '~~/server/lib/agent/runtime/types'

export interface RunRow {
  id: string
  trigger: RunTrigger
  wakeReason: string | null
  profile: RunProfile
  status: RunStatus
  suppressed: boolean
  createdAt: string
  finishedAt: string | null
  error: string | null
  durationMs: number | null
  assistantMessageId: string | null
}

const props = defineProps<{ conversationId: string | null }>()
const open = defineModel<boolean>('open', { required: true })

const toast = useToast()

// Keyed ['agentRun', conversationId] — the live dispatcher's OVERRIDES.agentRun entry
// (app/utils/live-dispatch.ts) invalidates the bare ['agentRun'] prefix on every run finish
// (queue.ts publishes the 'agentRun' resource), which matches this key regardless of which
// conversationId it carries.
const { data, error, isPending } = useQuery({
  queryKey: computed(() => ['agentRun', props.conversationId] as const),
  queryFn: () => $fetch<RunRow[]>('/api/agent/runs', { query: { conversationId: props.conversationId } }),
  enabled: computed(() => !!props.conversationId && open.value)
})
const runs = computed(() => data.value ?? [])

watch(error, (err) => {
  if (!err) return
  const e = err as { data?: { statusMessage?: string }, message?: string }
  toast.add({ color: 'error', title: 'Failed to load runs', description: e.data?.statusMessage ?? e.message })
})

function statusColor(s: RunStatus): 'success' | 'error' | 'warning' | 'neutral' | 'info' {
  return s === 'done' ? 'success' : s === 'failed' ? 'error' : s === 'interrupted' ? 'warning' : s === 'running' ? 'info' : 'neutral'
}
function rel(iso: string): string { return useTimeAgo(new Date(iso)).value }
function duration(ms: number | null): string | null {
  if (ms === null) return null
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}
</script>

<template>
  <USlideover
    v-model:open="open"
    title="Runs"
    description="Every turn on this thread, whatever started it."
    :ui="{ body: '!p-0' }"
  >
    <template #body>
      <div class="p-3 flex flex-col gap-2">
        <p v-if="isPending" class="px-1 py-8 text-center text-sm text-muted">
          Loading…
        </p>
        <p v-else-if="!runs.length" class="px-1 py-8 text-center text-sm text-muted">
          No runs yet.
        </p>
        <UCard
          v-for="r in runs"
          :key="r.id"
          :ui="{ body: 'p-3 sm:p-3' }"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="flex items-center gap-2 flex-wrap min-w-0">
              <UBadge
                :label="r.trigger === 'wake' ? `wake · ${r.wakeReason ?? '?'}` : 'user'"
                :color="r.trigger === 'wake' ? 'secondary' : 'primary'"
                variant="subtle"
                size="xs"
              />
              <UBadge
                :label="r.status"
                :color="statusColor(r.status)"
                variant="soft"
                size="xs"
              />
              <UBadge
                v-if="r.suppressed"
                label="silent"
                color="neutral"
                variant="outline"
                size="xs"
              />
            </div>
            <div class="shrink-0 text-right text-xs text-muted">
              <div>{{ rel(r.createdAt) }}</div>
              <div v-if="duration(r.durationMs)">{{ duration(r.durationMs) }}</div>
            </div>
          </div>
          <p v-if="r.error" class="mt-2 text-xs text-error">
            {{ r.error }}
          </p>
        </UCard>
      </div>
    </template>
  </USlideover>
</template>
