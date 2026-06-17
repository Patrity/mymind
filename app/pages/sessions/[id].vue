<script setup lang="ts">
import { useTimeAgo } from '@vueuse/core'
import SessionTranscript from '~/components/sessions/SessionTranscript.vue'

definePageMeta({ title: 'Session' })

const route = useRoute()
const { useSessionMeta, useSessionMessages } = useSessions()
const toast = useToast()

// ── Data ──────────────────────────────────────────────────────────────────────
const { data: meta, isPending: metaPending, error } = useSessionMeta(() => route.params.id as string)
const { data: msgData, isPending: messagesPending } = useSessionMessages(() => route.params.id as string)
const messages = computed(() => msgData.value?.messages ?? [])
const toolEvents = computed(() => msgData.value?.toolEvents ?? [])
const metaNotFound = computed(() => !metaPending.value && (error.value != null))

watch(error, (err) => {
  if (!err) return
  const e = err as { status?: number; data?: { statusCode?: number } }
  if (e.status === 404 || e.data?.statusCode === 404) {
    // metaNotFound is derived above — no toast needed for 404
    return
  }
  toast.add({ color: 'error', title: 'Failed to load session' })
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
                    <UBadge
                      v-if="meta.project"
                      :label="meta.project"
                      color="neutral"
                      variant="outline"
                      size="sm"
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
                  v-if="meta.cwd || gitBranch || gitRepo || meta.machineId || meta.appVersion"
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
                    v-if="meta.machineId"
                    class="text-xs text-dimmed font-mono truncate"
                  >
                    <UIcon name="i-lucide-monitor" class="size-3.5 inline mr-1" />{{ meta.machineId }}
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

        <div class="flex-1 min-w-0 h-full p-4">
          <SessionTranscript
            :messages="messages"
            :tool-events="toolEvents"
            :loading="messagesPending"
          />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
