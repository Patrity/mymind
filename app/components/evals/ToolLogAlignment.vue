<script setup lang="ts">
/**
 * An attempt's tool log against its case's expected actions, in the scorer's own alignment
 * (scoring.matched): matched calls beside their expected action, missing actions where they were
 * due, extra calls on their own, forbidden hits and denied / errored calls marked. Args and results
 * are model / fixture data — rendered as escaped text only.
 */
import type { EvalAttemptScoring, EvalToolLogEntry } from '@mymind/core/shared/types/eval'
import { alignToolLog, specLabel, type ActionSpecLike, type AlignedRow } from '~/lib/evals/display'

const props = defineProps<{
  expected: ActionSpecLike[]
  forbiddenSpecs: ActionSpecLike[]
  toolLog: EvalToolLogEntry[]
  scoring: EvalAttemptScoring | null
  countFailed: boolean
}>()

const rows = computed(() => alignToolLog(props.expected, props.toolLog, props.scoring))
const open = ref<Record<number, boolean>>({})

const KIND: Record<AlignedRow['kind'], { label: string, color: 'success' | 'error' | 'neutral' | 'warning', icon: string }> = {
  matched: { label: 'matched', color: 'success', icon: 'i-lucide-check' },
  missing: { label: 'missing', color: 'error', icon: 'i-lucide-circle-dashed' },
  unused: { label: 'alternative not needed', color: 'neutral', icon: 'i-lucide-minus' },
  extra: { label: 'extra', color: 'neutral', icon: 'i-lucide-plus' }
}
const STATUS_COLOR = { ok: 'neutral', error: 'error', denied: 'warning', pending: 'neutral' } as const
const args = (e: EvalToolLogEntry) => JSON.stringify(e.args, null, 2)
const hasArgs = (e: EvalToolLogEntry) => Object.keys(e.args ?? {}).length > 0
</script>

<template>
  <div
    class="flex flex-col gap-2"
    data-testid="eval-tool-log"
  >
    <div class="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] gap-x-3 border-b border-default pb-1 text-xs font-medium text-muted">
      <span>Expected</span>
      <span>Actual call</span>
      <span>Mark</span>
    </div>
    <p
      v-if="!rows.length"
      class="text-sm text-muted"
    >
      No tool calls and no expected actions.
    </p>
    <div
      v-for="(r, i) in rows"
      :key="i"
      class="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-start gap-x-3 rounded-md px-1 py-1.5"
      :class="r.forbidden.length ? 'bg-error/10' : r.kind === 'missing' ? 'bg-error/5' : ''"
      :data-testid="`eval-align-row-${r.kind}`"
      :data-forbidden="r.forbidden.length > 0 || undefined"
    >
      <div class="min-w-0 text-sm">
        <code
          v-if="r.expectedSpec"
          class="break-all text-highlighted"
        >{{ specLabel(r.expectedSpec) }}</code>
        <span
          v-else
          class="text-dimmed"
        >—</span>
      </div>

      <div class="min-w-0 text-sm">
        <template v-if="r.entry">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-xs text-dimmed">#{{ r.call! + 1 }}</span>
            <code class="break-all font-medium text-highlighted">{{ r.entry.tool }}</code>
            <UBadge
              v-if="r.entry.status !== 'ok'"
              :color="STATUS_COLOR[r.entry.status]"
              variant="subtle"
              size="xs"
              :label="r.entry.status"
              :data-testid="`eval-call-status-${r.entry.status}`"
            />
            <UTooltip
              v-if="r.entry.flagged"
              :text="r.entry.unverified ? 'The output guard could not check this result (fail-closed) — not a verdict' : `The output guard flagged this result (${r.entry.flagged})`"
            >
              <UBadge
                :color="r.entry.unverified ? 'neutral' : 'warning'"
                variant="subtle"
                size="xs"
                icon="i-lucide-shield-alert"
                :label="r.entry.unverified ? 'unverified' : 'flagged'"
                data-testid="eval-call-flagged"
              />
            </UTooltip>
            <UButton
              size="xs"
              color="neutral"
              variant="link"
              :label="open[i] ? 'hide' : 'details'"
              @click="open[i] = !open[i]"
            />
          </div>
          <div
            v-if="open[i]"
            class="mt-1 flex flex-col gap-1"
          >
            <pre
              v-if="hasArgs(r.entry)"
              class="max-h-60 overflow-auto rounded bg-elevated p-2 text-xs whitespace-pre-wrap break-all"
            >{{ args(r.entry) }}</pre>
            <pre
              v-if="r.entry.result"
              class="max-h-60 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap break-all text-toned"
            >{{ r.entry.result }}</pre>
          </div>
        </template>
        <span
          v-else
          class="text-dimmed"
        >no call</span>
      </div>

      <div class="flex flex-col items-end gap-1">
        <UBadge
          :color="KIND[r.kind].color"
          :icon="KIND[r.kind].icon"
          variant="subtle"
          size="sm"
          :label="KIND[r.kind].label"
        />
        <UTooltip
          v-for="f in r.forbidden"
          :key="f"
          :text="forbiddenSpecs[f] ? `matches forbidden ${specLabel(forbiddenSpecs[f])}` : 'matches a forbidden action'"
        >
          <UBadge
            color="error"
            variant="solid"
            size="sm"
            icon="i-lucide-octagon-x"
            label="forbidden"
            data-testid="eval-forbidden-hit"
          />
        </UTooltip>
        <span
          v-if="r.failed && r.kind === 'extra' && !countFailed && expected.some(s => s.tool === r.entry?.tool)"
          class="text-xs text-dimmed"
        >failed calls don't count</span>
      </div>
    </div>
  </div>
</template>
