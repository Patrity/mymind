<script setup lang="ts">
// Cycle 83 final fix wave (M2): in a CHILD workstream's log, what its coordinator said to it
// (answer_child / steer_workstream). It is the coordinator's model speaking, not Tony — so it gets its
// own "Coordinator" bubble on the left, never Tony's. Plain escaped text (an interpolation): the
// coordinator may relay what other agent runs wrote, so no markdown, links or previewers.
import type { EventDisplay } from '~/lib/workstreams/display'

defineProps<{ event: Extract<EventDisplay, { kind: 'coordinator' }> }>()
</script>

<template>
  <div
    class="flex max-w-[85%] flex-col items-start gap-1"
    data-testid="coordinator-message"
  >
    <UBadge
      color="info"
      variant="subtle"
      size="sm"
      icon="i-lucide-network"
      label="Coordinator"
    />
    <div
      class="whitespace-pre-wrap break-words rounded-lg border border-info/30 bg-info/5 px-3 py-2 text-sm text-default"
      data-testid="coordinator-message-body"
    >{{ event.body }}</div>
  </div>
</template>
