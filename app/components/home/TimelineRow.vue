<script setup lang="ts">
import type { TimelineEntry, TimelineType } from '~~/shared/types/home'

const props = defineProps<{ entry: TimelineEntry }>()

// Semantic tokens only — no raw palette classes.
const DOT: Record<TimelineType, string> = {
  session: 'bg-info',
  memory: 'bg-primary',
  document: 'bg-success',
  image: 'bg-success',
  clipboard: 'bg-success',
  task: 'bg-warning',
  conflict: 'bg-primary',
  error: 'bg-error'
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

// The coloured dot conveys type by colour alone (no text). Compose a text
// alternative here so screen-reader / colourblind users still get it — the
// dot itself is then marked aria-hidden since its meaning is carried here.
const ariaLabel = computed(() => `${props.entry.type}: ${props.entry.title}`)
</script>

<template>
  <ULink
    :to="entry.href"
    :aria-label="ariaLabel"
    class="flex items-start gap-3 py-2 px-1 -mx-1 rounded hover:bg-elevated/60 transition-colors"
  >
    <span
      class="size-2 rounded-full shrink-0 mt-1.5"
      :class="DOT[entry.type]"
      aria-hidden="true"
    />
    <div class="flex-1 min-w-0">
      <p class="text-sm text-default flex items-center gap-2 min-w-0">
        <ProjectBadge
          v-if="entry.projectSlug"
          :slug="entry.projectSlug"
          :name="entry.projectSlug"
          :to="null"
        />
        <!-- title="" so a truncated row is still readable on hover — the audit
             found 0 of 24 truncated labels in this app carry one. -->
        <span class="truncate" :title="entry.title">{{ entry.title }}</span>
      </p>
      <p
        v-if="entry.subtitle"
        class="text-xs text-muted truncate"
        :title="entry.subtitle"
      >
        {{ entry.subtitle }}
      </p>
    </div>
    <span class="text-xs text-dimmed shrink-0 tabular-nums">{{ time(entry.at) }}</span>
  </ULink>
</template>
