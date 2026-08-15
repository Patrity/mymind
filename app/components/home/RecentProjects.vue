<script setup lang="ts">
import type { HomeProjectRow } from '~~/shared/types/home'

defineProps<{ projects: HomeProjectRow[] }>()

// "1 session" not "1 sessions" — the audit found 11 hard-coded plurals across 5 files.
// Irregulars are explicit; naive +'s' would render "1.2k memorys".
const PLURALS: Record<string, string> = { session: 'sessions', memory: 'memories' }
const plural = (n: number, word: string) =>
  `${n} ${n === 1 ? word : (PLURALS[word] ?? `${word}s`)}`
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-highlighted">Projects</h2>
        <ULink to="/projects" class="text-xs text-primary">All</ULink>
      </div>
    </template>

    <p v-if="projects.length === 0" class="text-sm text-muted">
      No project activity in this range.
    </p>

    <div v-else class="flex flex-col gap-1.5">
      <ULink
        v-for="p in projects"
        :key="p.slug"
        :to="p.href"
        class="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity"
      >
        <ProjectBadge
          :slug="p.slug"
          :name="p.name"
          :color="p.color"
          :to="null"
        />
        <span class="text-xs text-dimmed truncate" :title="`${plural(p.sessions, 'session')} · ${plural(p.memories, 'memory')}`">
          {{ plural(p.sessions, 'session') }} · {{ plural(p.memories, 'memory') }}
        </span>
      </ULink>
    </div>
  </UCard>
</template>
