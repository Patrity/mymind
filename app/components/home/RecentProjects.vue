<script setup lang="ts">
import type { HomeProjectRow, HomeRangeKey } from '~~/shared/types/home'

const props = defineProps<{ projects: HomeProjectRow[], range: HomeRangeKey }>()

// "1 session" not "1 sessions". Irregulars are explicit; naive +'s' would render "18 memorys".
const PLURALS: Record<string, string> = {
  session: 'sessions',
  memory: 'memories',
  document: 'documents',
  'open task': 'open tasks'
}
const plural = (n: number, word: string) =>
  `${n} ${n === 1 ? word : (PLURALS[word] ?? `${word}s`)}`

/**
 * Icons match the sidebar's, so a count here reads as "the thing behind that nav item".
 * Sessions/memories/documents are range-scoped; open tasks is current backlog — the
 * tooltips say which, because the numbers sit side by side and would otherwise imply
 * the same window.
 *
 * `tip` is verbose because a tooltip is read on demand; `a11y` is terse because every one of
 * these concatenates into the row link's accessible name, and a screen-reader user should hear
 * "mymind, 2 sessions, 18 memories, 4 documents, 3 open tasks" — not the range clause four times.
 */
const statsFor = (p: HomeProjectRow) => [
  { key: 'sessions', icon: 'i-lucide-history', n: p.sessions, a11y: plural(p.sessions, 'session'), tip: `${plural(p.sessions, 'session')} in the last ${props.range}` },
  { key: 'memories', icon: 'i-lucide-brain', n: p.memories, a11y: plural(p.memories, 'memory'), tip: `${plural(p.memories, 'memory')} learned in the last ${props.range}` },
  { key: 'documents', icon: 'i-lucide-files', n: p.documents, a11y: plural(p.documents, 'document'), tip: `${plural(p.documents, 'document')} added in the last ${props.range}` },
  { key: 'tasks', icon: 'i-lucide-square-kanban', n: p.openTasks, a11y: plural(p.openTasks, 'open task'), tip: `${plural(p.openTasks, 'open task')} right now (not range-scoped)` }
]

/** Compact relative age — the card is narrow and "2h" carries as much as "2 hours ago" here. */
function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  return `${Math.round(days / 7)}w`
}

const exactly = (iso: string) =>
  `Last activity ${new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-highlighted">
          Projects
        </h2>
        <ULink
          to="/projects"
          class="text-xs text-primary"
        >
          All
        </ULink>
      </div>
    </template>

    <p
      v-if="projects.length === 0"
      class="text-sm text-muted"
    >
      No project activity in this range.
    </p>

    <div
      v-else
      class="flex flex-col gap-2"
    >
      <ULink
        v-for="p in projects"
        :key="p.slug"
        :to="p.href"
        class="flex items-center gap-2 min-w-0 rounded px-1 -mx-1 py-0.5 hover:bg-elevated/60 transition-colors"
      >
        <ProjectBadge
          :slug="p.slug"
          :name="p.name"
          :color="p.color"
          :to="null"
        />

        <!-- Stats sit right of the badge and left of the age, so the row's dead middle
             carries the data instead of whitespace. -->
        <div class="flex items-center gap-2.5 ml-auto shrink-0">
          <UTooltip
            v-for="s in statsFor(p)"
            :key="s.key"
            :text="s.tip"
          >
            <span
              class="flex items-center gap-1 text-xs tabular-nums"
              :class="s.n === 0 ? 'text-dimmed' : 'text-muted'"
              :aria-label="s.a11y"
            >
              <UIcon
                :name="s.icon"
                class="size-3.5"
                aria-hidden="true"
              />
              {{ s.n }}
            </span>
          </UTooltip>

          <UTooltip :text="exactly(p.lastActivityAt)">
            <span
              class="text-xs text-dimmed tabular-nums w-8 text-right"
              :aria-label="exactly(p.lastActivityAt)"
            >{{ ago(p.lastActivityAt) }}</span>
          </UTooltip>
        </div>
      </ULink>
    </div>
  </UCard>
</template>
