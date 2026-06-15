<script setup lang="ts">
import type { SessionMessageDTO, SessionToolEventDTO } from '~~/shared/types/session'
import { useTimeAgo } from '@vueuse/core'

definePageMeta({ title: 'Session' })

const route = useRoute()
const { useSessionDetail } = useSessions()
const toast = useToast()

// ── Data ──────────────────────────────────────────────────────────────────────
const { data: session, isPending, error } = useSessionDetail(() => route.params.id as string)
const loading = computed(() => isPending.value)
const notFound = computed(() => !isPending.value && (error.value != null))

watch(error, (err) => {
  if (!err) return
  const e = err as { status?: number; data?: { statusCode?: number } }
  if (e.status === 404 || e.data?.statusCode === 404) {
    // notFound is derived above — no toast needed for 404
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

// ── Message classification ────────────────────────────────────────────────────
type MsgKind = 'user' | 'assistant' | 'tool'

function msgKind(msg: SessionMessageDTO): MsgKind {
  if (msg.metadata?.type === 'tool_result') return 'tool'
  if (Array.isArray(msg.metadata?.tools) && (msg.metadata.tools as unknown[]).length > 0) return 'tool'
  if (msg.role === 'assistant') return 'assistant'
  return 'user'
}

function toolNames(msg: SessionMessageDTO): string[] {
  const tools = (msg.metadata as { tools?: unknown }).tools
  if (Array.isArray(tools)) {
    return tools
      .map(t => typeof t === 'string' ? t : (t && typeof t === 'object' ? ((t as { name?: string }).name ?? 'tool') : 'tool'))
      .filter(Boolean)
  }
  if (msg.metadata?.type === 'tool_result') {
    const name = (msg.metadata?.tool_name as string | undefined)
    return name ? [name] : ['tool_result']
  }
  return []
}

function hasMetaDetails(msg: SessionMessageDTO): boolean {
  return Object.keys(msg.metadata ?? {}).length > 0
}

function metaJson(msg: SessionMessageDTO): string {
  try {
    return JSON.stringify(msg.metadata, null, 2)
  } catch {
    return String(msg.metadata)
  }
}

// ── Git / metadata from session ────────────────────────────────────────────────
const gitBranch = computed(() => session.value?.gitBranch ?? null)
const gitRepo = computed(() => session.value?.gitRemote ?? null)
const gitCommit = computed(() => session.value?.gitCommit ?? null)

const sessionTitle = computed(() => {
  if (!session.value) return ''
  return session.value.title || session.value.summary || '(untitled session)'
})

// Open state tracking for metadata collapsibles
const openMeta = ref<Record<string, boolean>>({})
function toggleMeta(id: string) {
  openMeta.value[id] = !openMeta.value[id]
}

// ── Tool events ───────────────────────────────────────────────────────────────
const toolEventsByMsg = computed(() => {
  const m = new Map<string, SessionToolEventDTO[]>()
  for (const te of session.value?.toolEvents ?? []) {
    if (!te.messageId) continue
    const arr = m.get(te.messageId) ?? []
    arr.push(te)
    m.set(te.messageId, arr)
  }
  return m
})

function exitColor(s: string | null): 'success' | 'error' | 'neutral' {
  return s === 'ok' ? 'success' : s ? 'error' : 'neutral'
}
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
        v-if="loading"
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
        v-else-if="notFound"
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

      <!-- Content -->
      <div
        v-else-if="session"
        class="p-4 space-y-5 max-w-4xl mx-auto w-full"
      >
        <!-- Header card -->
        <UCard>
          <!-- Title / summary -->
          <div class="space-y-2">
            <div class="flex items-center gap-2 flex-wrap">
              <UBadge
                :label="session.source"
                :color="sourceColor(session.source)"
                variant="subtle"
                size="sm"
              />
              <UBadge
                v-if="session.project"
                :label="session.project"
                color="neutral"
                variant="outline"
                size="sm"
              />
            </div>
            <h1 class="text-lg font-semibold text-highlighted leading-snug">
              {{ sessionTitle }}
            </h1>
            <p
              v-if="session.title && session.summary"
              class="text-sm text-muted leading-relaxed"
            >
              {{ session.summary }}
            </p>
          </div>

          <!-- Stats row -->
          <div class="mt-4 flex flex-wrap gap-4 text-sm">
            <div class="flex items-center gap-1.5 text-muted">
              <UIcon name="i-lucide-message-circle" class="size-4" />
              <span>{{ session.messageCount }} messages</span>
            </div>
            <div class="flex items-center gap-1.5 text-muted">
              <UIcon name="i-lucide-wrench" class="size-4" />
              <span>{{ session.toolCount }} tool calls</span>
            </div>
            <div class="flex items-center gap-1.5 text-info">
              <UIcon name="i-lucide-arrow-up" class="size-4" />
              <span>{{ formatTokens(session.inputTokens) }} in</span>
            </div>
            <div class="flex items-center gap-1.5 text-success">
              <UIcon name="i-lucide-arrow-down" class="size-4" />
              <span>{{ formatTokens(session.outputTokens) }} out</span>
            </div>
          </div>

          <!-- Dates -->
          <div class="mt-3 flex flex-wrap gap-4 text-xs text-dimmed">
            <span>
              Started {{ formatDateFull(session.startedAt) }}
            </span>
            <span>
              Last active {{ relativeTime(session.lastActive) }}
            </span>
          </div>

          <!-- CWD + git + machine -->
          <div
            v-if="session.cwd || gitBranch || gitRepo || session.machineId || session.appVersion"
            class="mt-3 pt-3 border-t border-default space-y-1"
          >
            <p
              v-if="session.cwd"
              class="text-xs text-dimmed font-mono truncate"
            >
              <UIcon name="i-lucide-folder" class="size-3.5 inline mr-1" />{{ session.cwd }}
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
              v-if="session.machineId"
              class="text-xs text-dimmed font-mono truncate"
            >
              <UIcon name="i-lucide-monitor" class="size-3.5 inline mr-1" />{{ session.machineId }}
            </p>
            <p
              v-if="session.appVersion"
              class="text-xs text-dimmed font-mono"
            >
              <UIcon name="i-lucide-tag" class="size-3.5 inline mr-1" />{{ session.appVersion }}
            </p>
          </div>
        </UCard>

        <!-- Transcript -->
        <div class="space-y-2">
          <h2 class="text-sm font-semibold text-muted uppercase tracking-wider px-1">
            Transcript
          </h2>

          <!-- Scroll area with max height -->
          <div class="space-y-2 max-h-[70vh] overflow-y-auto pr-1">
            <template
              v-for="msg in session.messages"
              :key="msg.id"
            >
              <!-- Tool turn -->
              <div
                v-if="msgKind(msg) === 'tool'"
                class="flex items-start gap-2"
                :class="msg.isSidechain ? 'opacity-70' : ''"
              >
                <div class="w-full">
                  <UCard :ui="{ root: 'bg-elevated/40 border-muted', body: 'py-2 px-3' }">
                    <div class="flex items-start justify-between gap-2">
                      <div class="flex items-center gap-1.5 flex-wrap">
                        <UIcon name="i-lucide-wrench" class="size-3.5 text-warning shrink-0 mt-0.5" />
                        <template v-if="!toolEventsByMsg.get(msg.id)?.length">
                          <UBadge
                            v-for="name in toolNames(msg)"
                            :key="name"
                            :label="name"
                            color="warning"
                            variant="subtle"
                            size="xs"
                          />
                          <UBadge
                            v-if="msg.metadata?.type === 'tool_result'"
                            label="result"
                            color="neutral"
                            variant="outline"
                            size="xs"
                          />
                        </template>
                      </div>
                      <!-- Meta toggle -->
                      <UButton
                        v-if="hasMetaDetails(msg)"
                        icon="i-lucide-chevron-down"
                        :class="openMeta[msg.id] ? 'rotate-180' : ''"
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        class="shrink-0 transition-transform"
                        @click="toggleMeta(msg.id)"
                      />
                    </div>
                    <div
                      v-if="msg.content"
                      class="mt-1.5 text-xs text-muted font-mono line-clamp-3"
                    >
                      {{ msg.content.slice(0, 300) }}{{ msg.content.length > 300 ? '…' : '' }}
                    </div>
                    <!-- Tool event detail (new rows with tool_events populated) -->
                    <template v-if="toolEventsByMsg.get(msg.id)?.length">
                      <div
                        v-for="te in toolEventsByMsg.get(msg.id)"
                        :key="te.id"
                        class="mt-1.5"
                      >
                        <div class="flex items-center gap-1.5 flex-wrap">
                          <UBadge :label="te.toolName" color="warning" variant="subtle" size="xs" />
                          <UBadge v-if="te.exitStatus" :label="te.exitStatus" :color="exitColor(te.exitStatus)" variant="subtle" size="xs" />
                        </div>
                        <pre v-if="te.args" class="mt-1 text-xs text-dimmed font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto">{{ JSON.stringify(te.args, null, 2).slice(0, 500) }}</pre>
                        <pre v-if="te.result" class="mt-1 text-xs text-muted font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto">{{ typeof te.result === 'string' ? te.result.slice(0, 500) : JSON.stringify(te.result, null, 2).slice(0, 500) }}</pre>
                      </div>
                    </template>
                    <div
                      v-if="openMeta[msg.id]"
                      class="mt-2 pt-2 border-t border-muted"
                    >
                      <pre class="text-xs text-dimmed font-mono overflow-x-auto whitespace-pre-wrap break-words max-h-48">{{ metaJson(msg) }}</pre>
                    </div>
                  </UCard>
                </div>
              </div>

              <!-- User turn -->
              <div
                v-else-if="msgKind(msg) === 'user'"
                class="flex justify-end"
                :class="msg.isSidechain ? 'opacity-70' : ''"
              >
                <div class="max-w-[85%]">
                  <UCard :ui="{ root: 'bg-primary/10 border-primary/20', body: 'py-2.5 px-3.5' }">
                    <div class="flex items-start justify-between gap-2 mb-1.5">
                      <UBadge
                        label="user"
                        color="primary"
                        variant="subtle"
                        size="xs"
                      />
                      <UButton
                        v-if="hasMetaDetails(msg)"
                        icon="i-lucide-chevron-down"
                        :class="openMeta[msg.id] ? 'rotate-180' : ''"
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        class="shrink-0 transition-transform"
                        @click="toggleMeta(msg.id)"
                      />
                    </div>
                    <MdView :source="msg.content" />
                    <div
                      v-if="openMeta[msg.id]"
                      class="mt-2 pt-2 border-t border-muted"
                    >
                      <pre class="text-xs text-dimmed font-mono overflow-x-auto whitespace-pre-wrap break-words max-h-48">{{ metaJson(msg) }}</pre>
                    </div>
                  </UCard>
                </div>
              </div>

              <!-- Assistant turn -->
              <div
                v-else
                class="flex justify-start"
                :class="msg.isSidechain ? 'opacity-70' : ''"
              >
                <div class="max-w-[85%]">
                  <UCard :ui="{ body: 'py-2.5 px-3.5' }">
                    <div class="flex items-start justify-between gap-2 mb-1.5">
                      <div class="flex items-center gap-1.5 flex-wrap">
                        <UBadge
                          label="assistant"
                          color="neutral"
                          variant="subtle"
                          size="xs"
                        />
                        <span v-if="msg.model" class="text-xs text-dimmed font-mono">{{ msg.model }}</span>
                      </div>
                      <UButton
                        v-if="hasMetaDetails(msg)"
                        icon="i-lucide-chevron-down"
                        :class="openMeta[msg.id] ? 'rotate-180' : ''"
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        class="shrink-0 transition-transform"
                        @click="toggleMeta(msg.id)"
                      />
                    </div>
                    <details v-if="msg.thinking" class="mb-1.5">
                      <summary class="text-xs text-dimmed cursor-pointer select-none">thinking…</summary>
                      <pre class="mt-1 text-xs text-dimmed font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{{ msg.thinking }}</pre>
                    </details>
                    <MdView :source="msg.content" />
                    <div
                      v-if="openMeta[msg.id]"
                      class="mt-2 pt-2 border-t border-muted"
                    >
                      <pre class="text-xs text-dimmed font-mono overflow-x-auto whitespace-pre-wrap break-words max-h-48">{{ metaJson(msg) }}</pre>
                    </div>
                  </UCard>
                </div>
              </div>
            </template>

            <!-- Empty transcript -->
            <div
              v-if="!session.messages.length"
              class="flex flex-col items-center justify-center py-16 gap-3 text-center"
            >
              <UIcon
                name="i-lucide-message-square-off"
                class="size-10 text-muted"
              />
              <p class="text-sm text-muted">
                No messages in this session
              </p>
            </div>
          </div>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
