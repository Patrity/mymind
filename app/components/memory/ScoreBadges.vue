<!-- app/components/memory/ScoreBadges.vue
  A memory's scores side by side (cycle 77), shared by /review and /memories:
  - `confidence`: enrichment grading its own work, at extraction time;
  - Jev: an independent read of the same text;
  - the LLM audit: the extract-v3 criteria re-applied, with a verdict and a one-line reason.
  All three point the same way (higher = keep), so a big audit/Jev gap is the signal worth
  looking at. Advisory only: they sort and filter, they never decide. -->
<script setup lang="ts">
import type { AuditVerdict } from '@mymind/core/shared/types/memory'
import {
  scoreColor, pct, jevTooltip, auditTooltip, VERDICT_LABELS, verdictColor, disagreement, isDisagreement
} from '~/lib/memory/scores'

const props = withDefaults(defineProps<{
  confidence?: number | null
  /** Text after the confidence percent. */
  confidenceLabel?: string
  jevScore?: number | null
  jevAnswers?: Record<string, number> | null
  auditKeep?: number | null
  auditVerdict?: AuditVerdict | null
  auditReason?: string | null
  /** Show dimmed "not scored yet" placeholders instead of hiding a missing score. */
  showMissing?: boolean
}>(), {
  confidence: null,
  confidenceLabel: 'confidence',
  jevScore: null,
  jevAnswers: null,
  auditKeep: null,
  auditVerdict: null,
  auditReason: null,
  showMissing: false
})

const gap = computed(() => disagreement(props.auditKeep, props.jevScore))
const disagrees = computed(() => isDisagreement(props.auditKeep, props.jevScore))
</script>

<template>
  <span class="inline-flex items-center gap-2 flex-wrap">
    <UTooltip
      v-if="auditKeep != null || showMissing"
      :text="auditTooltip(auditKeep, auditVerdict, auditReason)"
    >
      <span
        data-testid="score-audit"
        :class="['inline-flex items-center gap-1 text-xs font-medium', scoreColor(auditKeep)]"
      >
        <template v-if="auditKeep != null">{{ pct(auditKeep) }} audit</template>
        <template v-else>audit —</template>
        <UBadge
          v-if="auditVerdict"
          :label="VERDICT_LABELS[auditVerdict]"
          :color="verdictColor(auditVerdict)"
          variant="subtle"
          size="xs"
        />
      </span>
    </UTooltip>

    <UTooltip
      v-if="jevScore != null || showMissing"
      :text="jevTooltip(jevScore, jevAnswers)"
    >
      <span
        data-testid="score-jev"
        :class="['text-xs font-medium', scoreColor(jevScore)]"
      >
        <template v-if="jevScore != null">{{ pct(jevScore) }} Jev</template>
        <template v-else>Jev —</template>
      </span>
    </UTooltip>

    <UTooltip
      v-if="disagrees && gap != null"
      :text="`The audit and Jev differ by ${pct(gap)} — worth a look.`"
    >
      <UBadge
        data-testid="score-disagree"
        label="disagree"
        color="warning"
        variant="outline"
        size="xs"
        icon="i-lucide-split"
      />
    </UTooltip>

    <span
      v-if="confidence != null"
      data-testid="score-confidence"
      class="text-xs text-muted"
    >
      {{ pct(confidence) }} {{ confidenceLabel }}
    </span>
  </span>
</template>
