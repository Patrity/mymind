<script setup lang="ts">
import type { HomeTaskRow } from '~~/shared/types/home'

defineProps<{ tasks: HomeTaskRow[] }>()

const due = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold text-highlighted">Active tasks</h2>
        <ULink to="/tasks" class="text-xs text-primary">All</ULink>
      </div>
    </template>

    <p v-if="tasks.length === 0" class="text-sm text-muted">
      Nothing in progress.
    </p>

    <div v-else class="flex flex-col">
      <ULink
        v-for="t in tasks"
        :key="t.id"
        :to="t.href"
        class="flex items-center gap-2 py-1.5 text-sm hover:text-primary transition-colors min-w-0"
      >
        <span class="truncate flex-1" :title="t.title">{{ t.title }}</span>
        <!-- Overdue carries a TEXT badge, not colour alone. -->
        <UBadge
          v-if="t.overdue"
          color="error"
          variant="subtle"
          size="sm"
          label="overdue"
        />
        <span v-else-if="due(t.dueDate)" class="text-xs text-dimmed shrink-0">{{ due(t.dueDate) }}</span>
      </ULink>
    </div>
  </UCard>
</template>
