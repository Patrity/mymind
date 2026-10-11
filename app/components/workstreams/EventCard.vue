<script setup lang="ts">
// A `workstream:<id>` event row in the chat a workstream was started from (cycle 81 Task 6): its
// finish / stopped / needs-you / approval / answered note, with a link to the workstream. The body
// can hold the model's own summary or question, so it renders through the hardened MessageResponse
// (app/lib/agent/markdown-harden.ts) — never MdView.
import { MessageResponse } from '@/components/ai-elements/message'
import type { EventDisplay } from '~/lib/workstreams/display'

defineProps<{ event: Extract<EventDisplay, { kind: 'workstream' }>; messageId: string }>()
</script>

<template>
  <UAlert
    :color="event.tone"
    variant="subtle"
    :icon="event.icon"
    class="my-3"
    :ui="{ description: 'text-default' }"
    data-testid="workstream-event"
    :data-workstream="event.workstreamId"
  >
    <template #title>
      <span class="font-medium">{{ event.title }}</span>
    </template>
    <template #description>
      <MessageResponse
        v-if="event.body"
        :key="`wsev-${messageId}`"
        :content="event.body"
        class="text-sm text-default"
      />
    </template>
    <template #actions>
      <UButton
        size="xs"
        variant="outline"
        color="neutral"
        trailing-icon="i-lucide-arrow-right"
        label="Open workstream"
        :to="`/workstreams/${event.workstreamId}`"
      />
    </template>
  </UAlert>
</template>
