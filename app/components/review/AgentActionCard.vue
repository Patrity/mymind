<!-- app/components/review/AgentActionCard.vue -->
<!-- kind: 'agent-action' (task-12) — a background run proposed a tool call instead of running
     it unattended (server/lib/agent/runtime/gate.ts's headlessTools). Approve replays the
     STORED call deterministically (server/lib/agent/runtime/replay.ts); reject does nothing. -->
<script setup lang="ts">
const props = defineProps<{
  item: { id: string; createdAt: string; proposed: { tool: string; args: Record<string, unknown>; conversationId?: string | null } }
  loading?: boolean
}>()
const emit = defineEmits<{ approve: [id: string]; reject: [id: string] }>()
const args = computed(() => JSON.stringify(props.item.proposed.args, null, 2))
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-center gap-2 flex-wrap min-w-0">
          <UIcon
            name="i-lucide-bot"
            class="size-4 shrink-0"
          />
          <span class="font-medium truncate">Bridget wants to run <code>{{ item.proposed.tool }}</code></span>
          <UBadge
            label="agent action"
            color="neutral"
            variant="outline"
            size="xs"
          />
        </div>
        <p class="text-xs text-dimmed shrink-0">
          {{ new Date(item.createdAt).toLocaleString() }}
        </p>
      </div>
    </template>

    <div class="space-y-2">
      <NuxtLink
        v-if="item.proposed.conversationId"
        :to="`/agent?c=${item.proposed.conversationId}`"
        class="text-xs text-muted hover:underline inline-flex items-center gap-1"
      >
        <UIcon name="i-lucide-message-square" class="size-3.5" />
        View this thread
      </NuxtLink>
      <pre class="text-xs whitespace-pre-wrap break-all max-h-64 overflow-auto p-3 rounded-md bg-muted">{{ args }}</pre>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          :loading="loading"
          @click="emit('reject', item.id)"
        >
          Reject
        </UButton>
        <UButton
          color="primary"
          size="sm"
          :loading="loading"
          @click="emit('approve', item.id)"
        >
          Approve and run
        </UButton>
      </div>
    </template>
  </UCard>
</template>
