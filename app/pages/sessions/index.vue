<script setup lang="ts">
import { useTimeAgo } from '@vueuse/core'

definePageMeta({ title: 'Sessions' })

const { useSessionList } = useSessions()
const toast = useToast()

// ── Data ──────────────────────────────────────────────────────────────────────
const { data, isPending: loading, error } = useSessionList()
const sessions = computed(() => data.value ?? [])

watch(error, (err) => {
  if (!err) return
  const e = err as { data?: { statusMessage?: string }; message?: string }
  toast.add({ color: 'error', title: 'Failed to load sessions', description: e.data?.statusMessage ?? e.message })
})

// ── Distinct filter options ────────────────────────────────────────────────────
const distinctSources = computed(() => {
  const seen = new Set<string>()
  for (const s of sessions.value) seen.add(s.source)
  return [...seen].sort()
})

const distinctProjects = computed(() => {
  const seen = new Set<string>()
  for (const s of sessions.value) {
    if (s.project) seen.add(s.project)
  }
  return [...seen].sort()
})

const sourceItems = computed(() => [
  { label: 'All sources', value: '__all__' },
  ...distinctSources.value.map(s => ({ label: s, value: s }))
])

const projectItems = computed(() => [
  { label: 'All projects', value: '__all__' },
  ...distinctProjects.value.map(p => ({ label: p, value: p }))
])

// ── Filters ───────────────────────────────────────────────────────────────────
const sourceFilter = ref('__all__')
const projectFilter = ref('__all__')
const searchQ = ref('')

const filtered = computed(() => {
  let rows = sessions.value
  if (sourceFilter.value !== '__all__') {
    rows = rows.filter(s => s.source === sourceFilter.value)
  }
  if (projectFilter.value !== '__all__') {
    rows = rows.filter(s => s.project === projectFilter.value)
  }
  if (searchQ.value.trim()) {
    const q = searchQ.value.trim().toLowerCase()
    rows = rows.filter(s =>
      (s.title ?? '').toLowerCase().includes(q) ||
      (s.summary ?? '').toLowerCase().includes(q) ||
      (s.project ?? '').toLowerCase().includes(q)
    )
  }
  return rows
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function sessionLabel(s: SessionListItem): string {
  return s.title || s.summary || '(untitled session)'
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function sourceColor(source: string): 'primary' | 'info' | 'warning' | 'neutral' {
  if (source === 'claude-code') return 'primary'
  if (source === 'hermes') return 'info'
  if (source === 'bridget') return 'warning'
  return 'neutral'
}

function relativeTime(iso: string) {
  return useTimeAgo(new Date(iso)).value
}
</script>

<template>
  <UDashboardPanel
    id="sessions"
    grow
    :ui="{ body: '!p-0' }"
  >
    <template #header>
      <UDashboardNavbar title="Sessions">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="p-4 space-y-4 max-w-5xl mx-auto w-full">
        <!-- Filters -->
        <div class="flex flex-col sm:flex-row gap-3 items-start sm:items-center w-full flex-wrap">
          <UInput
            v-model="searchQ"
            placeholder="Search sessions…"
            icon="i-lucide-search"
            class="w-full sm:flex-1"
          />
          <USelect
            v-model="sourceFilter"
            :items="sourceItems"
            value-key="value"
            class="w-44 shrink-0"
          />
          <USelect
            v-model="projectFilter"
            :items="projectItems"
            value-key="value"
            class="w-44 shrink-0"
          />
        </div>

        <!-- Loading skeletons -->
        <div
          v-if="loading"
          class="space-y-3"
        >
          <USkeleton
            v-for="i in 5"
            :key="i"
            class="h-24 w-full rounded-lg"
          />
        </div>

        <!-- Empty state -->
        <div
          v-else-if="!filtered.length"
          class="flex flex-col items-center justify-center py-24 gap-3 text-center"
        >
          <UIcon
            name="i-lucide-history"
            class="size-12 text-muted"
          />
          <p class="text-sm font-medium text-muted">
            No sessions found
          </p>
          <p class="text-xs text-dimmed">
            {{ searchQ.trim() ? 'Try a different search term.' : 'Sessions will appear here after ingestion.' }}
          </p>
        </div>

        <!-- Session rows -->
        <template v-else>
          <UCard
            v-for="session in filtered"
            :key="session.id"
            class="cursor-pointer hover:bg-elevated/50 transition-colors"
            @click="navigateTo('/sessions/' + session.id)"
          >
            <div class="flex items-start justify-between gap-3 flex-wrap">
              <!-- Left: title + badges -->
              <div class="min-w-0 flex-1 space-y-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <UBadge
                    :label="session.source"
                    :color="sourceColor(session.source)"
                    variant="subtle"
                    size="xs"
                  />
                  <UBadge
                    v-if="session.project"
                    :label="session.project"
                    color="neutral"
                    variant="outline"
                    size="xs"
                  />
                </div>
                <p class="text-sm font-medium text-default truncate leading-snug">
                  {{ sessionLabel(session) }}
                </p>
              </div>
              <!-- Right: relative time -->
              <p class="text-xs text-dimmed shrink-0 mt-0.5">
                {{ relativeTime(session.lastActive) }}
              </p>
            </div>

            <!-- Stats row -->
            <div class="mt-2 flex items-center gap-4 flex-wrap text-xs text-muted">
              <span class="flex items-center gap-1">
                <UIcon name="i-lucide-message-circle" class="size-3.5" />
                {{ session.messageCount }} messages
              </span>
              <span class="flex items-center gap-1">
                <UIcon name="i-lucide-wrench" class="size-3.5" />
                {{ session.toolCount }} tools
              </span>
              <span class="flex items-center gap-1">
                <UIcon name="i-lucide-arrow-up" class="size-3.5 text-info" />
                {{ formatTokens(session.inputTokens) }}
              </span>
              <span class="flex items-center gap-1">
                <UIcon name="i-lucide-arrow-down" class="size-3.5 text-success" />
                {{ formatTokens(session.outputTokens) }}
              </span>
            </div>
          </UCard>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
