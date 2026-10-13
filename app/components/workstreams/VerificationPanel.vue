<script setup lang="ts">
/**
 * Cycle 85 (spec §2.3): the outcome verifier on a workstream's detail page — a spinner line while it
 * checks a finish (`stateDetail: 'verifying'`), then its latest verdict: met, sent back (n of 2), or
 * finished flagged ("⚠ verifier: partial — …"). The gaps / next step / error are MODEL OUTPUT (the
 * verifier read untrusted evidence): rendered as escaped plain text only — never markdown, never links.
 */
import type { WorkstreamDTO } from '@mymind/core/shared/types/workstreams'
import { verificationView } from '~/lib/workstreams/display'

const props = defineProps<{ ws: Pick<WorkstreamDTO, 'state' | 'stateDetail' | 'verification' | 'sendBacks'> }>()
const view = computed(() => verificationView(props.ws.verification, props.ws.sendBacks))
const verifying = computed(() => props.ws.state === 'running' && props.ws.stateDetail === 'verifying')
</script>

<template>
  <div class="flex flex-col gap-2">
    <p
      v-if="verifying"
      class="flex items-center gap-1.5 text-xs text-muted"
      data-testid="workstream-verifying"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-3.5 animate-spin text-info"
      />
      The verifier is checking the work against the goal before it finishes.
    </p>
    <UAlert
      v-if="view && ws.verification"
      :color="view.color"
      variant="subtle"
      :icon="view.icon"
      :title="view.title"
      data-testid="workstream-verification"
    >
      <template #description>
        <ul
          v-if="ws.verification.gaps.length"
          class="list-disc ps-4 text-sm text-default"
          data-testid="workstream-verification-gaps"
        >
          <li
            v-for="(gap, i) in ws.verification.gaps"
            :key="i"
            class="whitespace-pre-wrap break-words"
          >
            {{ gap }}
          </li>
        </ul>
        <p
          v-if="ws.verification.nextStep && ws.verification.outcome !== 'finished'"
          class="mt-1 text-sm text-default whitespace-pre-wrap break-words"
        >
          Next: {{ ws.verification.nextStep }}
        </p>
        <p
          v-if="ws.verification.error && ws.verification.outcome !== 'skipped'"
          class="mt-1 text-sm text-default break-words"
        >
          {{ ws.verification.error }}
        </p>
        <p class="mt-1 text-xs text-muted">
          {{ ws.verification.model ?? 'no model' }} · {{ (ws.verification.latencyMs / 1000).toFixed(1) }}s<template v-if="ws.sendBacks">
            · sent back {{ ws.sendBacks }}×
          </template>
        </p>
      </template>
    </UAlert>
  </div>
</template>
