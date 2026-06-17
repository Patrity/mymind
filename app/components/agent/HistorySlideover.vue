<!-- app/components/agent/HistorySlideover.vue -->
<script setup lang="ts">
const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  select: [id: string]
}>()

const { useConversationList } = useConversations()
const { data } = useConversationList()
const conversations = computed(() => data.value ?? [])

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
</script>

<template>
  <USlideover
    :open="props.open"
    title="Conversation history"
    description="Select a conversation to resume it."
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <div class="flex flex-col gap-1">
        <UButton
          v-for="c in conversations"
          :key="c.id"
          block
          variant="ghost"
          color="neutral"
          class="text-left"
          @click="emit('select', c.id)"
        >
          <div class="flex flex-col gap-0.5 w-full">
            <span class="text-sm font-medium text-highlighted truncate">
              {{ c.title || 'New conversation' }}
            </span>
            <span class="text-xs text-muted">
              {{ formatRelative(c.lastMessageAt) }}
              <template v-if="c.snippet">
                · {{ c.snippet }}
              </template>
            </span>
          </div>
        </UButton>

        <p
          v-if="conversations.length === 0"
          class="px-3 py-8 text-center text-sm text-muted"
        >
          No conversations yet.
        </p>
      </div>
    </template>

    <template #footer>
      <UButton
        label="Browse all →"
        variant="ghost"
        color="neutral"
        class="w-full justify-center"
        @click="navigateTo('/agent/history')"
      />
    </template>
  </USlideover>
</template>
