<!-- app/components/agent/JudgeVerdict.vue -->
<!-- Cycle 84 (spec §2.5): the judge's state on an approval card — a spinner while it evaluates,
     then a risk badge, the recommendation, the confidence and up to three reasons. Reasons (and
     the rule tier's reasons, which may quote call text) are MODEL OUTPUT: interpolated as plain
     text only, never v-html or markdown. -->
<script setup lang="ts">
import type { ApprovalVerdictDTO } from '@mymind/core/lib/agent/judge/types'
import { verdictView } from '~/lib/agent/judge-display'

const props = defineProps<{ judge: ApprovalVerdictDTO | null | undefined }>()
const view = computed(() => verdictView(props.judge))
</script>

<template>
  <div
    v-if="view"
    class="flex flex-col gap-1.5 rounded bg-elevated/40 px-2 py-1.5 text-xs"
    data-testid="judge-verdict"
    :data-kind="view.kind"
  >
    <div
      v-if="view.kind === 'pending'"
      class="flex items-center gap-1.5 text-muted"
      data-testid="judge-pending"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-3.5 animate-spin"
      />
      <span>⚖ Judging this call…</span>
      <span
        v-if="view.autoPossible"
        class="text-dimmed"
      >Smart Approvals may run it without you.</span>
    </div>
    <div
      v-else-if="view.kind === 'error'"
      class="flex flex-wrap items-center gap-1.5 text-muted"
      data-testid="judge-error"
    >
      <UBadge
        color="neutral"
        variant="subtle"
        size="sm"
        label="⚖ no verdict"
      />
      <span>{{ view.error }} — review it yourself.</span>
    </div>
    <template v-else>
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-muted">⚖</span>
        <UBadge
          :color="view.riskColor"
          variant="subtle"
          size="sm"
          :label="`${view.risk ?? 'unknown'} risk`"
          data-testid="judge-risk"
        />
        <UBadge
          :color="view.recommendationColor"
          variant="outline"
          size="sm"
          :label="view.recommendation"
          data-testid="judge-recommendation"
        />
        <span
          class="text-dimmed"
          data-testid="judge-confidence"
        >confidence {{ view.confidence }}</span>
      </div>
      <ul
        v-if="view.reasons.length"
        class="list-disc pl-5 text-muted"
        data-testid="judge-reasons"
      >
        <li
          v-for="(r, i) in view.reasons"
          :key="i"
          class="break-words"
        >
          {{ r }}
        </li>
      </ul>
    </template>
    <div
      v-if="view.taint"
      class="flex flex-wrap items-center gap-1.5 text-muted"
      data-testid="judge-taint"
    >
      <UBadge
        color="warning"
        variant="soft"
        size="sm"
        icon="i-lucide-biohazard"
        :label="view.taint"
      />
      <span>This run read untrusted content, so Smart Approvals is off for it — every approval waits for you.</span>
    </div>
    <div
      v-if="view.rule"
      class="flex flex-wrap items-center gap-1.5 text-muted"
      data-testid="judge-rule"
    >
      <UBadge
        color="error"
        variant="soft"
        size="sm"
        :label="`rule: ${view.rule.floor}`"
      />
      <span class="break-words">{{ view.rule.reasons.join(' · ') || 'always needs you' }}</span>
    </div>
  </div>
</template>
