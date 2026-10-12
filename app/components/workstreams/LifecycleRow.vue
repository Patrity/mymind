<script setup lang="ts">
// Cycle 83: a child's lifecycle note in its coordinator's log (spawned / finished / failed / …) —
// state only, never the child's output, so a compact one-line row with a link to the child. The goal
// is the coordinator's own text; it renders as an escaped interpolation.
// The log is a gap-8 column; -my-3 packs consecutive notes ~8px apart (they come in bursts).
import type { EventDisplay } from '~/lib/workstreams/display'

defineProps<{ event: Extract<EventDisplay, { kind: 'lifecycle' }> }>()
// Literal class names (Tailwind only emits classes it can see in the source).
const TONE_CLASS: Record<string, string> = {
  primary: 'text-primary', secondary: 'text-secondary', info: 'text-info', success: 'text-success',
  warning: 'text-warning', error: 'text-error', neutral: 'text-muted'
}
</script>

<template>
  <div
    class="-my-3 flex items-center gap-2 text-xs text-muted"
    data-testid="workstream-lifecycle"
    :data-workstream="event.workstreamId"
  >
    <UIcon
      :name="event.icon"
      :class="['size-3.5 shrink-0', TONE_CLASS[event.tone]]"
    />
    <span class="shrink-0">Child</span>
    <ULink
      :to="`/workstreams/${event.workstreamId}`"
      class="min-w-0 truncate font-medium text-toned hover:text-highlighted"
    >{{ event.goal }}</ULink>
    <span class="shrink-0">{{ event.label }}</span>
  </div>
</template>
