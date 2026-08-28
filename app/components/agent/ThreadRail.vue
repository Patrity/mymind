<!-- app/components/agent/ThreadRail.vue -->
<script setup lang="ts">
import type { ConversationListItem } from '~~/shared/types/conversation'

const props = defineProps<{ activeId: string | null }>()
const emit = defineEmits<{ select: [id: string]; new: [] }>()

const q = ref('')
const { useConversationList } = useConversations()
const { data, error } = useConversationList(() => ({ q: q.value.trim() || undefined }))
const conversations = computed(() => data.value ?? [])

// Surface load failures — the rail is now the primary way into a thread, so a
// silently empty list would read as "you have no conversations".
const toast = useToast()
watch(error, (err) => {
  if (!err) return
  const e = err as { data?: { statusMessage?: string }; message?: string }
  toast.add({ color: 'error', title: 'Failed to load conversations', description: e.data?.statusMessage ?? e.message })
})

/** Group by Today / Yesterday / date — the rail's only structural device. */
const groups = computed(() => {
  const out = new Map<string, ConversationListItem[]>()
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yest = new Date(today); yest.setDate(yest.getDate() - 1)
  for (const c of conversations.value) {
    const d = c.lastMessageAt ? new Date(c.lastMessageAt) : null
    const key = !d
      ? 'Earlier'
      : d >= today
          ? 'Today'
          : d >= yest
            ? 'Yesterday'
            : d.toLocaleDateString()
    if (!out.has(key)) out.set(key, [])
    out.get(key)!.push(c)
  }
  return [...out.entries()]
})
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="p-2 flex flex-col gap-2 border-b border-default">
      <UButton
        block
        icon="i-lucide-plus"
        label="New conversation"
        size="sm"
        color="neutral"
        variant="soft"
        @click="emit('new')"
      />
      <UInput
        v-model="q"
        icon="i-lucide-search"
        placeholder="Search…"
        size="sm"
      />
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-3">
      <div
        v-for="[label, items] in groups"
        :key="label"
        class="flex flex-col gap-0.5"
      >
        <span class="px-2 text-[10px] font-medium uppercase tracking-wider text-dimmed">{{ label }}</span>
        <UButton
          v-for="c in items"
          :key="c.id"
          block
          :color="c.id === props.activeId ? 'primary' : 'neutral'"
          :variant="c.id === props.activeId ? 'soft' : 'ghost'"
          class="text-left"
          @click="emit('select', c.id)"
        >
          <div class="flex flex-col gap-0.5 w-full min-w-0">
            <span class="text-sm truncate">{{ c.title || 'New conversation' }}</span>
            <span class="text-xs text-muted truncate">{{ c.messageCount }} messages</span>
          </div>
        </UButton>
      </div>

      <p
        v-if="!conversations.length"
        class="px-3 py-8 text-center text-sm text-muted"
      >
        {{ q.trim() ? 'No matches.' : 'No conversations yet.' }}
      </p>
    </div>
  </div>
</template>
