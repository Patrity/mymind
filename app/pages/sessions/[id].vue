<script setup lang="ts">
import type { SessionDetail, SessionMessageDTO } from '~~/shared/types/session'
import { useTimeAgo } from '@vueuse/core'

definePageMeta({ title: 'Session' })

const route = useRoute()
const { get } = useSessions()
const toast = useToast()

// ── Data ──────────────────────────────────────────────────────────────────────
const session = ref<SessionDetail | null>(null)
const notFound = ref(false)
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    session.value = await get(route.params.id as string)
  } catch (e: unknown) {
    const err = e as { status?: number; data?: { statusCode?: number } }
    if (err.status === 404 || err.data?.statusCode === 404) {
      notFound.value = true
    } else {
      toast.add({ color: 'error', title: 'Failed to load session' })
    }
  } finally {
    loading.value = false
  }
}

onMounted(load)

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
  const tools = msg.metadata?.tools
  if (Array.isArray(tools)) {
    return (tools as Array<{ name?: string; input?: { name?: string } }>)
      .map(t => t?.name ?? (t?.input as { name?: string } | undefined)?.name ?? 'tool')
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
const gitBranch = computed(() => {
  const meta = session.value?.metadata ?? {}
  return (meta.git_branch as string | undefined) ?? (meta.branch as string | undefined) ?? null
})

const gitRepo = computed(() => {
  const meta = session.value?.metadata ?? {}
  return (meta.git_repo as string | undefined) ?? (meta.repo as string | undefined) ?? null
})

const sessionTitle = computed(() => {
  if (!session.value) return ''
  return session.value.title || session.value.summary || '(untitled session)'
})

// Open state tracking for metadata collapsibles
const openMeta = ref<Record<string, boolean>>({})
function toggleMeta(id: string) {
  openMeta.value[id] = !openMeta.value[id]
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

          <!-- CWD + git -->
          <div
            v-if="session.cwd || gitBranch || gitRepo"
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
              <UIcon name="i-lucide-git-branch" class="size-3.5 inline mr-1" />{{ gitBranch }}
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
              >
                <div class="w-full">
                  <UCard :ui="{ root: 'bg-elevated/40 border-muted', body: 'py-2 px-3' }">
                    <div class="flex items-start justify-between gap-2">
                      <div class="flex items-center gap-1.5 flex-wrap">
                        <UIcon name="i-lucide-wrench" class="size-3.5 text-warning shrink-0 mt-0.5" />
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
              >
                <div class="max-w-[85%]">
                  <UCard :ui="{ body: 'py-2.5 px-3.5' }">
                    <div class="flex items-start justify-between gap-2 mb-1.5">
                      <UBadge
                        label="assistant"
                        color="neutral"
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
