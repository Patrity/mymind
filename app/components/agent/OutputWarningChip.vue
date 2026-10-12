<!-- app/components/agent/OutputWarningChip.vue -->
<!-- Cycle 84 (spec §3.3): the output guard flagged this tool call's result as a likely prompt
     injection. A chip on the tool part; expanding it lists the source and the reasons. The reasons
     include the classifier's own words (MODEL OUTPUT steered by the scanned text) — plain text
     interpolation only, never v-html or markdown. -->
<script setup lang="ts">
import type { OutputWarningDTO } from '@mymind/core/lib/agent/judge/types'
import { formatConfidence, guardSourceLabel } from '~/lib/agent/judge-display'

defineProps<{ warning: OutputWarningDTO }>()
</script>

<template>
  <UCollapsible
    class="-mt-2 mb-3 flex flex-col gap-1.5"
    data-testid="output-warning"
  >
    <template #default="{ open }">
      <UButton
        color="warning"
        variant="soft"
        size="xs"
        icon="i-lucide-shield-alert"
        :trailing-icon="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        label="Possible prompt injection"
        class="self-start"
        data-testid="output-warning-chip"
      />
    </template>
    <template #content>
      <div
        class="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-xs"
        data-testid="output-warning-details"
      >
        <p class="text-muted">
          Found in {{ guardSourceLabel(warning.source) }}. Bridget was told to treat it as data. For the
          rest of this run, web requests and background work need your approval, and Smart Approvals
          won't approve anything on its own.
          <span v-if="warning.llm">Classifier confidence {{ formatConfidence(warning.llm.confidence) }}.</span>
        </p>
        <ul
          v-if="warning.reasons.length"
          class="mt-1 list-disc pl-5 text-default"
          data-testid="output-warning-reasons"
        >
          <li
            v-for="(r, i) in warning.reasons"
            :key="i"
            class="break-words"
          >
            {{ r }}
          </li>
        </ul>
      </div>
    </template>
  </UCollapsible>
</template>
