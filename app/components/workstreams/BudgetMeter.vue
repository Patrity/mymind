<script setup lang="ts">
// A workstream's budget (spec §5.5): steps and ACTIVE time against their limits, plus cost and
// tokens. The tooltips say what is not counted (Task 5 decisions): waiting time, and sub-agents.
import type { WorkstreamBudget, WorkstreamUsed } from '@mymind/core/shared/types/workstreams'
import { BUDGET_NOTES, formatCost, formatDuration } from '~/lib/workstreams/display'

const props = defineProps<{ budget: WorkstreamBudget; used: WorkstreamUsed }>()
const stepsPct = computed(() => Math.min(100, Math.round((props.used.steps / Math.max(1, props.budget.maxSteps)) * 100)))
const wallPct = computed(() => Math.min(100, Math.round((props.used.wallMs / Math.max(1, props.budget.maxWallMs)) * 100)))
const tone = (pct: number) => (pct >= 100 ? 'error' : pct >= 80 ? 'warning' : 'primary')
const tokens = computed(() => {
  const t = props.used.inputTokens + props.used.outputTokens
  return t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t)
})
</script>

<template>
  <div
    class="grid gap-3 sm:grid-cols-3"
    data-testid="workstream-budget"
  >
    <UTooltip :text="BUDGET_NOTES.steps">
      <div class="flex flex-col gap-1">
        <div class="flex items-center justify-between text-xs text-muted">
          <span class="flex items-center gap-1">Steps <UIcon
            name="i-lucide-info"
            class="size-3"
          /></span>
          <span
            class="tabular-nums"
            data-testid="budget-steps"
          >{{ used.steps }} / {{ budget.maxSteps }}</span>
        </div>
        <UProgress
          :model-value="stepsPct"
          :color="tone(stepsPct)"
          size="sm"
        />
      </div>
    </UTooltip>
    <UTooltip :text="BUDGET_NOTES.wall">
      <div class="flex flex-col gap-1">
        <div class="flex items-center justify-between text-xs text-muted">
          <span class="flex items-center gap-1">Active time <UIcon
            name="i-lucide-info"
            class="size-3"
          /></span>
          <span
            class="tabular-nums"
            data-testid="budget-wall"
          >{{ formatDuration(used.wallMs) }} / {{ formatDuration(budget.maxWallMs) }}</span>
        </div>
        <UProgress
          :model-value="wallPct"
          :color="tone(wallPct)"
          size="sm"
        />
      </div>
    </UTooltip>
    <UTooltip :text="`Best effort, from model prices. ${BUDGET_NOTES.steps}`">
      <div class="flex flex-col gap-1 text-xs text-muted">
        <span class="flex items-center gap-1">Cost <UIcon
          name="i-lucide-info"
          class="size-3"
        /></span>
        <span class="tabular-nums text-sm text-default">{{ formatCost(used.costUsd) }} · {{ tokens }} tokens</span>
      </div>
    </UTooltip>
  </div>
</template>
