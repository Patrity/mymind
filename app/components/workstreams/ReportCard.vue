<script setup lang="ts">
// Cycle 83: a `segment:children` report in a coordinator's log — the children's states, questions
// and summaries the coordinator was woken with (or that were steered into its running segment).
// Everything under the head line is text CHILD runs wrote: untrusted data. It renders as escaped
// plain text only (a text interpolation in a <pre>; no markdown, no links, no images, no previewers)
// and is styled as untrusted. Collapsed by default — the head line says what it is.
import type { EventDisplay } from '~/lib/workstreams/display'

defineProps<{ event: Extract<EventDisplay, { kind: 'report' }> }>()
</script>

<template>
  <UCollapsible
    class="my-3 rounded-md border border-dashed border-warning/40 bg-warning/5"
    data-testid="workstream-report"
  >
    <UButton
      color="neutral"
      variant="ghost"
      size="sm"
      block
      icon="i-lucide-inbox"
      trailing-icon="i-lucide-chevron-down"
      class="group justify-start"
      :ui="{ trailingIcon: 'ms-auto transition-transform group-data-[state=open]:rotate-180' }"
    >
      <span class="truncate text-left font-medium text-default">{{ event.title }}</span>
      <UBadge
        v-if="event.body"
        color="warning"
        variant="subtle"
        size="sm"
        icon="i-lucide-shield-alert"
        label="untrusted — written by child runs"
        class="ms-2 shrink-0"
      />
    </UButton>
    <template #content>
      <pre
        v-if="event.body"
        class="max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-dashed border-warning/40 px-3 py-2 font-mono text-xs text-toned"
        data-testid="workstream-report-body"
      >{{ event.body }}</pre>
    </template>
  </UCollapsible>
</template>
