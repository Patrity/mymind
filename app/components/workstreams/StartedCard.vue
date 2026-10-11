<script setup lang="ts">
// The compact card under a `start_workstream` tool call in chat (spec §5.5): what was started, its
// live state, and the link. The goal is model-written, so it is shown as plain text (clamped).
import { STATE_META } from '~/lib/workstreams/display'

const props = defineProps<{ id: string; goal: string }>()
const { data } = useWorkstream(() => props.id)
const meta = computed(() => (data.value ? STATE_META[data.value.state] : null))
</script>

<template>
  <UCard
    variant="subtle"
    class="mb-3 shrink-0"
    :ui="{ body: 'p-3 sm:p-3' }"
    data-testid="workstream-started-card"
    :data-workstream="id"
  >
    <div class="flex items-center gap-3">
      <UIcon
        name="i-lucide-cog"
        class="size-5 shrink-0 text-primary"
      />
      <div class="min-w-0 flex-1">
        <p class="text-xs text-muted">
          Workstream started
        </p>
        <p class="truncate text-sm text-highlighted">
          {{ data?.goal ?? goal }}
        </p>
      </div>
      <UBadge
        v-if="meta"
        :color="meta.color"
        variant="subtle"
        size="sm"
        :label="meta.label"
      />
      <UButton
        size="xs"
        variant="outline"
        color="neutral"
        trailing-icon="i-lucide-arrow-right"
        label="Open"
        :to="`/workstreams/${id}`"
      />
    </div>
  </UCard>
</template>
