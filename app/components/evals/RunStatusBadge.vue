<script setup lang="ts">
import type { EvalRunStatus } from '@mymind/core/shared/types/eval'
import { RUN_STATUS_META } from '~/lib/evals/display'

const props = defineProps<{ status: EvalRunStatus }>()
const meta = computed(() => RUN_STATUS_META[props.status] ?? RUN_STATUS_META.queued)
</script>

<template>
  <UBadge
    :color="meta.color"
    variant="subtle"
    size="sm"
    :label="meta.label"
    :ui="{ leadingIcon: status === 'running' ? 'animate-spin' : '' }"
    :icon="meta.icon"
    :data-testid="`eval-run-status-${status}`"
  />
</template>
