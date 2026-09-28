<script setup lang="ts">
/**
 * Right-column status of one job on /jobs/[slug] (cycle 74): validation, when it fires next (in
 * the job's own timezone), Run now, and its last 10 runs. Reads the GET /api/jobs/:slug envelope
 * the page already holds, so it makes no request of its own except Run now.
 */
import { useQueryClient } from '@tanstack/vue-query'
import { deliverLabel } from '~/lib/jobs/deliver-label'
import {
  emptyPreviewReason, formatAgo, formatDuration, formatInZone, formatRelative, outcomeColor, runNowToast, runOutcome, runThreadLink,
  type JobRunRow, type RunNowResult
} from '~/lib/jobs/display'

interface JobInfo {
  slug: string
  content: string
  enabled: boolean
  triggerKind: string | null
  timezone: string | null
  description: string | null
  parseError: string | null
  consecutiveFailures: number
  deliver: string[]
}

const props = defineProps<{
  job: JobInfo | null
  nextFireTimes: string[]
  runs: JobRunRow[]
  /** The message of the last rejected save (400), shown in place of "valid". */
  saveError?: string | null
}>()

const toast = useToast()
const qc = useQueryClient()

const validationError = computed(() => props.saveError ?? props.job?.parseError ?? null)

const now = ref(new Date())
useIntervalFn(() => {
  now.value = new Date()
}, 30_000)

const running = ref(false)
async function runNow() {
  if (!props.job) return
  running.value = true
  try {
    const res = await $fetch<RunNowResult>(`/api/jobs/${props.job.slug}/run`, { method: 'POST' })
    toast.add(runNowToast(res))
    void qc.invalidateQueries({ queryKey: ['jobs'] })
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Run failed to start', description: err.data?.statusMessage ?? err.message })
  } finally {
    running.value = false
  }
}
</script>

<template>
  <div
    class="flex flex-col gap-4 p-3 text-sm"
    data-testid="job-status"
  >
    <!-- Validation -->
    <div>
      <UAlert
        v-if="validationError"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-x"
        title="Invalid"
        :description="validationError"
        data-testid="job-validation-error"
      />
      <div
        v-else
        class="flex items-center gap-2 text-success"
        data-testid="job-validation-ok"
      >
        <UIcon
          name="i-lucide-circle-check"
          class="size-4"
        />
        <span>Valid</span>
      </div>
      <p
        v-if="job && job.consecutiveFailures > 0"
        class="mt-2 text-xs text-warning"
      >
        {{ job.consecutiveFailures }} failed run{{ job.consecutiveFailures === 1 ? '' : 's' }} in a row — 3 disables the job.
      </p>
    </div>

    <!-- Schedule -->
    <div>
      <div class="flex items-center gap-2 mb-1">
        <UIcon
          name="i-lucide-calendar-clock"
          class="size-4 text-dimmed"
        />
        <span class="font-medium text-highlighted">Schedule</span>
      </div>
      <p
        class="text-muted"
        data-testid="job-trigger-description"
      >
        {{ job?.description ?? '—' }}
      </p>
      <p
        v-if="job?.timezone"
        class="text-xs text-dimmed"
      >
        {{ job.timezone }}
      </p>
      <p
        v-if="job && !job.enabled"
        class="mt-2 text-xs text-warning"
      >
        Disabled — it will not fire until you turn it on.
      </p>
      <ul
        v-if="nextFireTimes.length"
        class="mt-2 flex flex-col gap-1"
        data-testid="job-next-fire-times"
      >
        <li
          v-for="t in nextFireTimes"
          :key="t"
          class="flex justify-between gap-2"
        >
          <span>{{ formatInZone(t, job?.timezone) }}</span>
          <span class="text-xs text-dimmed shrink-0">{{ formatRelative(t, now) }}</span>
        </li>
      </ul>
      <p
        v-else-if="job && emptyPreviewReason(job)"
        class="mt-2 text-xs text-dimmed"
        data-testid="job-no-fire-times"
      >
        {{ emptyPreviewReason(job) }}
      </p>
    </div>

    <!-- Delivery -->
    <div v-if="job">
      <div class="flex items-center gap-2 mb-1">
        <UIcon
          name="i-lucide-send"
          class="size-4 text-dimmed"
        />
        <span class="font-medium text-highlighted">Delivers to</span>
      </div>
      <p
        class="text-muted"
        data-testid="job-deliver-label"
      >
        {{ deliverLabel(job.deliver) }}
      </p>
    </div>

    <UButton
      icon="i-lucide-play"
      size="sm"
      color="neutral"
      variant="outline"
      label="Run now"
      block
      :loading="running"
      :disabled="!job"
      data-testid="job-run-now"
      @click="runNow"
    />

    <!-- Runs -->
    <div>
      <div class="flex items-center gap-2 mb-1">
        <UIcon
          name="i-lucide-list-checks"
          class="size-4 text-dimmed"
        />
        <span class="font-medium text-highlighted">Recent runs</span>
      </div>
      <p
        v-if="!runs.length"
        class="text-xs text-dimmed"
      >
        No runs yet.
      </p>
      <ul
        v-else
        class="flex flex-col divide-y divide-default"
        data-testid="job-runs"
      >
        <li
          v-for="r in runs"
          :key="r.id"
          class="flex items-center gap-2 py-1.5"
          :data-run="r.id"
        >
          <UBadge
            :color="outcomeColor(runOutcome(r))"
            variant="subtle"
            size="sm"
            class="shrink-0"
            data-testid="job-run-outcome"
          >
            {{ runOutcome(r) }}
          </UBadge>
          <UTooltip :text="formatInZone(r.createdAt, job?.timezone)">
            <span class="text-xs text-muted truncate">{{ formatAgo(r.createdAt, now) }}</span>
          </UTooltip>
          <span class="text-xs text-dimmed shrink-0">{{ formatDuration(r.durationMs) }}</span>
          <span class="ml-auto shrink-0 text-xs">
            <ULink
              v-if="runThreadLink(r)"
              :to="runThreadLink(r)!"
              class="text-primary"
              data-testid="job-run-thread-link"
            >view in thread</ULink>
            <span
              v-else-if="runOutcome(r) === 'silent'"
              class="text-dimmed"
            >silent</span>
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>
