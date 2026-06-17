<!-- app/pages/agent/history.vue -->
<script setup lang="ts">
definePageMeta({ title: 'Conversations' })

const { useConversationList, remove } = useConversations()
const toast = useToast()

// ── Search ────────────────────────────────────────────────────────────────────
const q = ref('')

// ── Data (reactive getter → re-queries on q change) ───────────────────────────
const { data, error, isPending } = useConversationList(() => ({
  q: q.value.trim() || undefined
}))

const conversations = computed(() => data.value ?? [])

watch(error, (err) => {
  if (!err) return
  const e = err as { data?: { statusMessage?: string }; message?: string }
  toast.add({ color: 'error', title: 'Failed to load conversations', description: e.data?.statusMessage ?? e.message })
})

// ── Relative time ─────────────────────────────────────────────────────────────
function formatRelative(dateStr: string | null): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

// ── Delete ────────────────────────────────────────────────────────────────────
const deleting = ref<Record<string, boolean>>({})

async function doDelete(id: string) {
  deleting.value[id] = true
  try {
    await remove(id)
    // Live event (publishChange) auto-invalidates the list — no manual refetch needed
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }; message?: string }
    toast.add({ color: 'error', title: 'Delete failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    deleting.value[id] = false
  }
}
</script>

<template>
  <UDashboardPanel
    id="agent-history"
    grow
    :ui="{ body: '!p-0' }"
  >
    <template #header>
      <UDashboardNavbar title="Conversations">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #trailing>
          <UButton
            label="New conversation"
            icon="i-lucide-plus"
            color="primary"
            size="sm"
            @click="navigateTo('/agent')"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="p-4 space-y-4 max-w-3xl mx-auto w-full">
        <!-- Search -->
        <UInput
          v-model="q"
          icon="i-lucide-search"
          placeholder="Search conversations…"
          class="w-full"
          :loading="isPending && q.trim().length > 0"
          trailing
        />

        <!-- Error state -->
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          title="Failed to load conversations"
          :description="(error as { data?: { statusMessage?: string }; message?: string }).data?.statusMessage ?? (error as { message?: string }).message"
        />

        <!-- Loading skeletons -->
        <div
          v-else-if="isPending"
          class="space-y-2"
        >
          <USkeleton
            v-for="i in 5"
            :key="i"
            class="h-16 w-full rounded-lg"
          />
        </div>

        <!-- Empty state -->
        <div
          v-else-if="conversations.length === 0"
          class="flex flex-col items-center justify-center py-24 gap-3 text-center"
        >
          <UIcon
            name="i-lucide-message-square"
            class="size-12 text-muted"
          />
          <p class="text-sm font-medium text-muted">
            {{ q.trim() ? 'No conversations match your search.' : 'No conversations yet.' }}
          </p>
          <p class="text-xs text-dimmed">
            {{ q.trim() ? 'Try a different keyword.' : 'Start a conversation in the agent tab.' }}
          </p>
          <UButton
            v-if="!q.trim()"
            label="Open agent"
            icon="i-lucide-bot"
            color="primary"
            variant="soft"
            size="sm"
            @click="navigateTo('/agent')"
          />
        </div>

        <!-- Conversation rows -->
        <div
          v-else
          class="flex flex-col gap-1"
        >
          <div
            v-for="c in conversations"
            :key="c.id"
            class="flex items-center gap-2 group"
          >
            <UButton
              block
              variant="ghost"
              color="neutral"
              class="text-left flex-1 min-w-0"
              @click="navigateTo('/agent?c=' + c.id)"
            >
              <div class="flex items-center justify-between gap-3 w-full min-w-0">
                <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                  <span class="text-sm font-medium text-highlighted truncate">
                    {{ c.title || 'New conversation' }}
                  </span>
                  <span class="text-xs text-muted truncate">
                    {{ formatRelative(c.lastMessageAt) }}
                    <template v-if="c.messageCount">
                      · {{ c.messageCount }} {{ c.messageCount === 1 ? 'message' : 'messages' }}
                    </template>
                    <template v-if="c.snippet">
                      · {{ c.snippet }}
                    </template>
                  </span>
                </div>
              </div>
            </UButton>

            <!-- Per-row delete -->
            <UButton
              icon="i-lucide-trash"
              color="neutral"
              variant="ghost"
              size="sm"
              :loading="deleting[c.id]"
              class="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label="Delete conversation"
              @click.stop="doDelete(c.id)"
            />
          </div>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
