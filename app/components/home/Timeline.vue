<script setup lang="ts">
import type { HomeTimeline, HomeRangeKey } from '~~/shared/types/home'

const props = defineProps<{ timeline: HomeTimeline, range: HomeRangeKey }>()

// Mobile treatment 2: cap the list and expand on demand rather than reordering.
const MOBILE_PREVIEW = 12
const expanded = ref(false)

const flat = computed(() => props.timeline.days.flatMap(d => d.entries.map(e => ({ day: d.day, entry: e }))))
const visible = computed(() => expanded.value ? flat.value : flat.value.slice(0, MOBILE_PREVIEW))
const hasMore = computed(() => flat.value.length > MOBILE_PREVIEW)

const dayLabel = (day: string) => {
  const today = new Date().toISOString().slice(0, 10)
  const yest = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  if (day === today) return 'Today'
  if (day === yest) return 'Yesterday'
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'
  })
}

// Show a day header only when the day changes as we walk the flat list.
const showHeader = (i: number) => i === 0 || visible.value[i]!.day !== visible.value[i - 1]!.day
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-highlighted">What happened</h2>
        <span class="text-xs text-muted">last {{ range }}</span>
      </div>
    </template>

    <div
      v-if="flat.length === 0"
      class="flex flex-col items-center justify-center gap-2 py-12 text-muted"
    >
      <UIcon name="i-lucide-wind" class="size-8 text-dimmed" />
      <p class="text-sm">Nothing in the last {{ range }}.</p>
      <p class="text-xs text-dimmed">Try a wider range.</p>
    </div>

    <div v-else class="px-4 pb-3">
      <template
        v-for="(row, i) in visible"
        :key="row.entry.id"
      >
        <p
          v-if="showHeader(i)"
          class="text-xs font-semibold uppercase tracking-wide text-dimmed mt-4 mb-1 first:mt-2"
        >
          {{ dayLabel(row.day) }}
        </p>
        <HomeTimelineRow :entry="row.entry" />
      </template>

      <div class="flex items-center justify-between pt-3">
        <UButton
          v-if="hasMore"
          size="xs"
          variant="ghost"
          color="neutral"
          :label="expanded ? 'Show less' : `Show ${flat.length - MOBILE_PREVIEW} more`"
          @click="expanded = !expanded"
        />
        <!-- Truncation is DISCLOSED, never silent. -->
        <span
          v-if="timeline.shown < timeline.total"
          class="text-xs text-dimmed ml-auto"
        >
          Showing {{ timeline.shown }} of {{ timeline.total }}
        </span>
      </div>
    </div>
  </UCard>
</template>
