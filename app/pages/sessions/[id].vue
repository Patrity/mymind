<script setup lang="ts">
import { useTimeAgo } from '@vueuse/core'
import { useQueryClient, type InfiniteData } from '@tanstack/vue-query'
import SessionTranscript from '~/components/sessions/SessionTranscript.vue'
import ReassignProjectModal from '~/components/sessions/ReassignProjectModal.vue'
import type { SessionMessageFilters, SessionMessagesPage } from '~~/shared/types/session'

definePageMeta({ title: 'Session' })

const route = useRoute()
const { useSessionMeta, useSessionMessagePages, getMessages } = useSessions()
const toast = useToast()
const qc = useQueryClient()

// ── Data ──────────────────────────────────────────────────────────────────────
const { data: meta, isPending: metaPending, error } = useSessionMeta(() => route.params.id as string)

// A ref, NOT a `reactive()`: the composable reads these through `toValue`, which doesn't
// unwrap a reactive object — its computed would register no dependency and a filter change
// would silently never refetch. The filter bar replaces the object wholesale for the same reason.
const filters = ref<SessionMessageFilters>({})

const {
  data: pageData,
  isPending: messagesPending,
  error: messagesError,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage
} = useSessionMessagePages(() => route.params.id as string, filters)

// Pages walk newest → oldest and each page is newest-first internally; the transcript reads
// top-down oldest-first. Reverse both levels.
const messages = computed(() =>
  [...(pageData.value?.pages ?? [])].reverse().flatMap(p => [...p.messages].reverse()))
const toolEvents = computed(() => (pageData.value?.pages ?? []).flatMap(p => p.toolEvents))
const metaNotFound = computed(() => !metaPending.value && (error.value != null))

// A filter change is a different query key, so the transcript starts from a clean first page —
// remount it so the scroll state (tail pin, "requested at length") starts clean too.
const transcriptKey = computed(() => JSON.stringify(filters.value))

// ── Live append ─────────────────────────────────────────────────────────────────
// The meta query refetches on SSE `session` events, so its messageCount rises when new turns
// are ingested. When it grows, fetch only the delta (messages newer than the last one we hold)
// and append it to the NEWEST page of the paged cache — no full transcript refetch.
watch(() => meta.value?.messageCount, async (count, prev) => {
  if (count == null || prev == null || count <= prev) return
  const id = route.params.id as string
  const active = { ...filters.value }
  const cur = messages.value
  if (!cur.length) {
    // Nothing to anchor a `since` on (an empty or fully-filtered-out transcript): a delta
    // request would return the whole filtered session, so let the query refetch page one.
    await qc.invalidateQueries({ queryKey: ['session', id, 'messages', 'paged'] })
    return
  }
  // The newest held row goes over WHOLE: the delta's boundary is the (created_at, id) composite,
  // so a row ingested later at the same timestamp still lands on the right side of it.
  const delta = await getMessages(id, cur[cur.length - 1]!, active)
  if (!delta.messages.length && !delta.toolEvents.length) return
  qc.setQueryData(
    messagePagesKey(id, active),
    (old: InfiniteData<SessionMessagesPage, string | undefined> | undefined) => {
      const newest = old?.pages[0]
      if (!old || !newest) return old
      // `since` is exclusive, but a concurrent refetch can already hold these rows — de-dup by id.
      const seen = new Set(newest.messages.map(m => m.id))
      const fresh = delta.messages.filter(m => !seen.has(m.id))
      const seenTev = new Set(newest.toolEvents.map(t => t.id))
      const freshTev = delta.toolEvents.filter(t => !seenTev.has(t.id))
      if (!fresh.length && !freshTev.length) return old
      return {
        ...old,
        // The delta arrives oldest-first; a page is newest-first, and page 0 is the newest page.
        pages: [
          { ...newest, messages: [...fresh].reverse().concat(newest.messages), toolEvents: [...newest.toolEvents, ...freshTev] },
          ...old.pages.slice(1)
        ]
      }
    }
  )
}, { flush: 'post' })

watch(error, (err) => {
  if (!err) return
  const e = err as { status?: number; data?: { statusCode?: number } }
  if (e.status === 404 || e.data?.statusCode === 404) {
    // metaNotFound is derived above — no toast needed for 404
    return
  }
  toast.add({ color: 'error', title: 'Failed to load session' })
})

watch(messagesError, (err) => {
  if (err) toast.add({ color: 'error', title: 'Failed to load transcript' })
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function relativeTime(iso: string) {
  return useTimeAgo(new Date(iso)).value
}

function formatDateFull(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function sourceColor(source: string): 'primary' | 'info' | 'warning' | 'neutral' {
  if (source === 'claude-code') return 'primary'
  if (source === 'hermes') return 'info'
  if (source === 'bridget') return 'warning'
  return 'neutral'
}

// ── Git / metadata from session ────────────────────────────────────────────────
const gitBranch = computed(() => meta.value?.gitBranch ?? null)
const gitRepo = computed(() => meta.value?.gitRemote ?? null)
const gitCommit = computed(() => meta.value?.gitCommit ?? null)

const sessionTitle = computed(() => {
  if (!meta.value) return ''
  return meta.value.title || meta.value.summary || '(untitled session)'
})

// ── Reassignment ──────────────────────────────────────────────────────────────
const reassignOpen = ref(false)
</script>

<template>
  <UDashboardPanel
    id="session-detail"
    grow
    :ui="{ body: '!p-0' }"
  >
    <template #header>
      <UDashboardNavbar :title="sessionTitle || 'Session'">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #trailing>
          <UButton
            to="/sessions"
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="ghost"
            size="sm"
            label="All sessions"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- Loading -->
      <div
        v-if="metaPending"
        class="p-4 space-y-4 max-w-4xl mx-auto"
      >
        <USkeleton class="h-10 w-2/3 rounded-lg" />
        <USkeleton class="h-20 w-full rounded-lg" />
        <USkeleton
          v-for="i in 4"
          :key="i"
          class="h-32 w-full rounded-lg"
        />
      </div>

      <!-- Not found -->
      <div
        v-else-if="metaNotFound"
        class="flex flex-col items-center justify-center py-32 gap-4 text-center"
      >
        <UIcon
          name="i-lucide-file-question"
          class="size-12 text-muted"
        />
        <p class="text-base font-semibold text-default">
          Session not found
        </p>
        <p class="text-sm text-muted">
          This session may have been deleted or the ID is invalid.
        </p>
        <UButton
          to="/sessions"
          icon="i-lucide-arrow-left"
          color="primary"
          variant="soft"
          size="sm"
        >
          Back to sessions
        </UButton>
      </div>

      <!-- Content: resizable split-pane (LEFT metadata / RIGHT transcript) -->
      <div
        v-else-if="meta"
        class="flex flex-1 min-w-0 h-full"
      >
        <UDashboardPanel
          id="session-meta"
          resizable
          :default-size="34"
          :min-size="22"
          :max-size="55"
          class="border-r border-default"
        >
          <template #body>
            <div class="p-4 overflow-y-auto h-full">
              <!-- Header card -->
              <UCard>
                <!-- Title / summary -->
                <div class="space-y-2">
                  <div class="flex items-center gap-2 flex-wrap">
                    <UBadge
                      :label="meta.source"
                      :color="sourceColor(meta.source)"
                      variant="subtle"
                      size="sm"
                    />
                    <ProjectBadge
                      v-if="meta.project"
                      :slug="meta.project"
                    />
                    <UButton
                      icon="i-lucide-folder-input"
                      color="neutral"
                      variant="ghost"
                      size="xs"
                      :label="meta.project ? 'Move' : 'Assign project'"
                      @click="reassignOpen = true"
                    />
                  </div>
                  <h1 class="text-lg font-semibold text-highlighted leading-snug">
                    {{ sessionTitle }}
                  </h1>
                  <p
                    v-if="meta.title && meta.summary"
                    class="text-sm text-muted leading-relaxed"
                  >
                    {{ meta.summary }}
                  </p>
                </div>

                <!-- Stats row -->
                <div class="mt-4 flex flex-wrap gap-4 text-sm">
                  <div class="flex items-center gap-1.5 text-muted">
                    <UIcon name="i-lucide-message-circle" class="size-4" />
                    <span>{{ meta.messageCount }} messages</span>
                  </div>
                  <div class="flex items-center gap-1.5 text-muted">
                    <UIcon name="i-lucide-wrench" class="size-4" />
                    <span>{{ meta.toolCount }} tool calls</span>
                  </div>
                  <div class="flex items-center gap-1.5 text-info">
                    <UIcon name="i-lucide-arrow-up" class="size-4" />
                    <span>{{ formatTokens(meta.inputTokens) }} in</span>
                  </div>
                  <div class="flex items-center gap-1.5 text-success">
                    <UIcon name="i-lucide-arrow-down" class="size-4" />
                    <span>{{ formatTokens(meta.outputTokens) }} out</span>
                  </div>
                </div>

                <!-- Dates -->
                <div class="mt-3 flex flex-wrap gap-4 text-xs text-dimmed">
                  <span>
                    Started {{ formatDateFull(meta.startedAt) }}
                  </span>
                  <span>
                    Last active {{ relativeTime(meta.lastActive) }}
                  </span>
                </div>

                <!-- CWD + git + machine -->
                <div
                  v-if="meta.cwd || gitBranch || gitRepo || meta.hostname || meta.machineId || meta.appVersion"
                  class="mt-3 pt-3 border-t border-default space-y-1"
                >
                  <p
                    v-if="meta.cwd"
                    class="text-xs text-dimmed font-mono truncate"
                  >
                    <UIcon name="i-lucide-folder" class="size-3.5 inline mr-1" />{{ meta.cwd }}
                  </p>
                  <p
                    v-if="gitRepo"
                    class="text-xs text-dimmed font-mono truncate"
                  >
                    <UIcon name="i-lucide-git-commit-horizontal" class="size-3.5 inline mr-1" />{{ gitRepo }}
                  </p>
                  <p
                    v-if="gitBranch"
                    class="text-xs text-dimmed font-mono"
                  >
                    <UIcon name="i-lucide-git-branch" class="size-3.5 inline mr-1" />{{ gitBranch }}{{ gitCommit ? ' @ ' + gitCommit.slice(0, 8) : '' }}
                  </p>
                  <p
                    v-if="meta.hostname || meta.machineId"
                    class="text-xs text-dimmed font-mono truncate"
                    :title="meta.machineId ?? undefined"
                  >
                    <UIcon name="i-lucide-monitor" class="size-3.5 inline mr-1" />{{ meta.hostname ?? meta.machineId }}
                  </p>
                  <p
                    v-if="meta.appVersion"
                    class="text-xs text-dimmed font-mono"
                  >
                    <UIcon name="i-lucide-tag" class="size-3.5 inline mr-1" />{{ meta.appVersion }}
                  </p>
                </div>
              </UCard>
            </div>
          </template>
        </UDashboardPanel>

        <div class="flex-1 min-w-0 h-full p-4 flex flex-col min-h-0">
          <SessionsTranscriptFilters
            v-model="filters"
            :tool-names="meta.toolNames ?? []"
          />
          <div class="flex-1 min-h-0">
            <SessionTranscript
              :key="transcriptKey"
              :messages="messages"
              :tool-events="toolEvents"
              :loading="messagesPending"
              :has-more="hasNextPage"
              :fetching-more="isFetchingNextPage"
              :error="!!messagesError"
              @load-more="fetchNextPage()"
            />
          </div>
        </div>
      </div>

      <ReassignProjectModal
        v-if="meta"
        v-model:open="reassignOpen"
        :session-ids="[meta.id]"
        :current-cwd="meta.cwd"
        :current-project="meta.project"
      />
    </template>
  </UDashboardPanel>
</template>
