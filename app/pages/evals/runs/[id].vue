<script setup lang="ts">
/**
 * /evals/runs/[id] (spec §3.5): one run — provenance, its pass rates, and per case its pass, mean
 * score and attempts (each links to the attempt). Live while it runs: every result and summary
 * rewrite publishes `eval`, so the progress bar and the attempt chips fill in as they land.
 */
import type { TableColumn } from '@nuxt/ui'
import type { EvalCaseSummary, EvalResultLite } from '@mymind/core/shared/types/eval'
import { isLive, pct, runProgress, score } from '~/lib/evals/display'
import { formatAgo } from '~/lib/jobs/display'
import { formatDuration } from '~/lib/workstreams/display'

definePageMeta({ title: 'Eval run' })

const route = useRoute()
const toast = useToast()
const id = computed(() => String(route.params.id ?? ''))
const { data, error, isPending } = useEvalRun(id)
watch(error, (err) => {
  if (err) toast.add({ color: 'error', title: 'Could not load the run', description: evalErrorOf(err).message })
})
const run = computed(() => data.value?.run ?? null)
const progress = computed(() => (run.value ? runProgress(run.value) : null))
const live = computed(() => !!run.value && isLive(run.value.status))

interface CaseRow { id: string, slug: string, holdout: boolean, surface: string, summary: EvalCaseSummary | null, attempts: EvalResultLite[] }
const rows = computed<CaseRow[]>(() => {
  const v = data.value
  if (!v) return []
  const sums = new Map((v.run.summary?.cases ?? []).map(c => [c.caseId, c]))
  return v.cases.map(c => ({
    ...c,
    summary: sums.get(c.id) ?? null,
    attempts: v.results.filter(r => r.caseId === c.id).sort((a, b) => a.attempt - b.attempt)
  }))
})
const columns: TableColumn<CaseRow>[] = [
  { id: 'pass', header: 'Pass' },
  { accessorKey: 'slug', header: 'Case' },
  { id: 'mean', header: 'Mean' },
  { id: 'attempts', header: 'Attempts' }
]

const attemptColor = (r: EvalResultLite) => (r.failed || r.error ? 'error' : r.forbidden ? 'error' : r.passed ? 'success' : (r.score ?? 0) > 0 ? 'warning' : 'error')
const attemptTip = (r: EvalResultLite) => [
  `#${r.attempt} · score ${score(r.score)}`,
  r.forbidden ? 'forbidden action' : null,
  r.verdict ? `judge: ${r.verdict}` : null,
  r.failed ? `failed: ${r.failed}` : null,
  r.durationMs ? formatDuration(r.durationMs) : null
].filter(Boolean).join(' · ')

const { cancelRun } = useEvalActions()
async function cancel() {
  try {
    await cancelRun.mutateAsync(id.value)
  } catch (e) {
    toast.add({ color: 'error', title: 'Could not cancel', description: evalErrorOf(e).message })
  }
}
</script>

<template>
  <UDashboardPanel
    id="eval-run-panel"
    grow
  >
    <template #header>
      <UDashboardNavbar :title="data ? `${data.suite.name} · run` : 'Eval run'">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UButton
            v-if="data"
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="ghost"
            size="xs"
            :to="`/evals/suites/${data.suite.id}`"
            aria-label="Back to the suite"
          />
        </template>
        <template #right>
          <UButton
            v-if="live"
            icon="i-lucide-square"
            size="xs"
            color="error"
            variant="subtle"
            label="Cancel run"
            :loading="cancelRun.isPending.value"
            data-testid="eval-run-cancel"
            @click="cancel"
          />
        </template>
      </UDashboardNavbar>
      <AgentWorkerOfflineBanner />
    </template>

    <template #body>
      <USkeleton
        v-if="isPending"
        class="h-40"
      />
      <template v-else-if="data && run">
        <div class="flex flex-wrap items-center gap-3">
          <EvalsRunStatusBadge :status="run.status" />
          <span class="text-sm text-muted">started {{ formatAgo(run.startedAt) }}</span>
          <span
            v-if="run.summary?.durationMs"
            class="text-sm text-muted"
          >· {{ formatDuration(run.summary.durationMs) }}</span>
          <span
            v-if="run.summary?.tokens"
            class="text-sm text-muted"
          >· {{ run.summary.tokens.toLocaleString() }} tokens</span>
        </div>

        <div
          v-if="live"
          class="flex flex-col gap-1"
          data-testid="eval-run-progress"
        >
          <UProgress
            :model-value="progress?.ratio === null ? null : Math.round((progress?.ratio ?? 0) * 100)"
            :max="100"
            color="info"
          />
          <span class="text-xs text-muted">
            {{ run.status === 'queued' ? 'Waiting for the agent worker to pick it up…' : `${progress?.done} of ${progress?.planned ?? '?'} attempts done` }}
          </span>
        </div>

        <UAlert
          v-if="run.error"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          title="The run failed"
          :description="run.error"
        />

        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <UCard
            class="shrink-0"
            :ui="{ body: 'p-3 sm:p-3' }"
          >
            <p class="text-xs text-muted">
              Pass rate (non-holdout)
            </p>
            <p
              class="text-xl font-semibold text-highlighted"
              data-testid="eval-run-passrate"
            >
              {{ pct(run.summary?.nonHoldout.passRate) }}
            </p>
            <p class="text-xs text-muted">
              {{ run.summary?.nonHoldout.passed ?? 0 }}/{{ run.summary?.nonHoldout.cases ?? 0 }} cases
            </p>
          </UCard>
          <UCard
            class="shrink-0"
            :ui="{ body: 'p-3 sm:p-3' }"
          >
            <p class="text-xs text-muted">
              Mean score
            </p>
            <p class="text-xl font-semibold text-highlighted">
              {{ score(run.summary?.nonHoldout.meanScore) }}
            </p>
          </UCard>
          <UCard
            class="shrink-0"
            :ui="{ body: 'p-3 sm:p-3' }"
          >
            <p class="text-xs text-muted">
              Holdout
            </p>
            <p class="text-xl font-semibold text-highlighted">
              {{ pct(run.summary?.holdout.passRate) }}
            </p>
            <p class="text-xs text-muted">
              {{ run.summary?.holdout.passed ?? 0 }}/{{ run.summary?.holdout.cases ?? 0 }} cases
            </p>
          </UCard>
          <UCard
            class="shrink-0"
            :ui="{ body: 'p-3 sm:p-3' }"
          >
            <p class="text-xs text-muted">
              Attempts
            </p>
            <p class="text-xl font-semibold text-highlighted">
              {{ run.summary?.attempts ?? 0 }}
            </p>
            <p
              v-if="run.summary?.failedAttempts"
              class="text-xs text-error"
            >
              {{ run.summary.failedAttempts }} failed
            </p>
          </UCard>
        </div>

        <UCard
          class="shrink-0"
          :ui="{ body: 'p-0 sm:p-0' }"
        >
          <UTable
            :data="rows"
            :columns="columns"
            data-testid="eval-run-cases"
          >
            <template #pass-cell="{ row }">
              <UBadge
                v-if="row.original.summary && row.original.summary.attempts"
                :color="row.original.summary.passed ? 'success' : 'error'"
                :icon="row.original.summary.passed ? 'i-lucide-check' : 'i-lucide-x'"
                variant="subtle"
                size="sm"
                :label="row.original.summary.passed ? 'pass' : row.original.summary.forbidden ? 'forbidden' : 'fail'"
                :data-testid="`eval-case-pass-${row.original.slug}`"
              />
              <UIcon
                v-else-if="live"
                name="i-lucide-loader-circle"
                class="size-4 animate-spin text-info"
              />
              <span
                v-else
                class="text-xs text-dimmed"
              >—</span>
            </template>
            <template #slug-cell="{ row }">
              <span class="font-medium text-highlighted">{{ row.original.slug }}</span>
              <UBadge
                v-if="row.original.holdout"
                color="secondary"
                variant="subtle"
                size="xs"
                label="holdout"
                class="ms-1"
              />
            </template>
            <template #mean-cell="{ row }">
              {{ score(row.original.summary?.meanScore) }}
            </template>
            <template #attempts-cell="{ row }">
              <div class="flex flex-wrap gap-1">
                <UTooltip
                  v-for="a in row.original.attempts"
                  :key="a.id"
                  :text="attemptTip(a)"
                >
                  <UButton
                    :to="`/evals/attempts/${a.id}`"
                    size="xs"
                    :color="attemptColor(a)"
                    variant="subtle"
                    :label="`#${a.attempt} ${score(a.score)}`"
                    :data-testid="`eval-attempt-${row.original.slug}-${a.attempt}`"
                  />
                </UTooltip>
              </div>
            </template>
          </UTable>
        </UCard>

        <UCard class="shrink-0">
          <template #header>
            <span class="text-sm font-medium text-highlighted">Provenance</span>
          </template>
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt class="text-muted">
              Model
            </dt><dd>{{ run.modelLabel ?? '—' }}</dd>
            <dt class="text-muted">
              Git SHA
            </dt><dd><code>{{ run.gitSha ?? '—' }}</code></dd>
            <dt class="text-muted">
              Prompt hash
            </dt><dd><code class="break-all">{{ run.promptHash ?? '—' }}</code></dd>
            <dt class="text-muted">
              Tools hash
            </dt><dd><code class="break-all">{{ run.toolsHash ?? '—' }}</code></dd>
            <dt class="text-muted">
              Scope
            </dt><dd>
              {{ run.params.cases?.join(', ') || 'all enabled cases' }}<template v-if="run.params.n">
                · n={{ run.params.n }}
              </template>
            </dd>
          </dl>
        </UCard>
      </template>
    </template>
  </UDashboardPanel>
</template>
