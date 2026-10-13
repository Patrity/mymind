<script setup lang="ts">
/**
 * /evals/suites/[id] (spec §3.5): a suite — its run history (chart + table; pick two to compare),
 * its cases (enable toggles, edit), Run (a case filter and an attempts override) and Export.
 */
import type { TableColumn } from '@nuxt/ui'
import type { EvalCaseListItem, EvalRunDTO } from '@mymind/core/shared/types/eval'
import { pct, runProgress, score } from '~/lib/evals/display'
import { formatAgo } from '~/lib/jobs/display'

definePageMeta({ title: 'Eval suite' })

const route = useRoute()
const toast = useToast()
const id = computed(() => String(route.params.id ?? ''))
const { data, error, isPending } = useEvalSuite(id)
watch(error, (err) => {
  if (err) toast.add({ color: 'error', title: 'Could not load the suite', description: evalErrorOf(err).message })
})
const cases = computed(() => data.value?.cases ?? [])
const runs = computed(() => data.value?.runs ?? [])

// ── Runs: pick two to compare ─────────────────────────────────────────────
const picked = ref<string[]>([])
function togglePick(runId: string, on: boolean) {
  picked.value = on ? [...picked.value.filter(r => r !== runId), runId].slice(-2) : picked.value.filter(r => r !== runId)
}
function compare() {
  // Older run as A, newer as B (runs are newest first).
  const order = runs.value.map(r => r.id)
  const [a, b] = [...picked.value].sort((x, y) => order.indexOf(y) - order.indexOf(x))
  void navigateTo({ path: '/evals/compare', query: { a, b } })
}

const runColumns: TableColumn<EvalRunDTO>[] = [
  { id: 'pick', header: '' },
  { id: 'status', header: 'Status' },
  { id: 'started', header: 'Started' },
  { id: 'rate', header: 'Pass rate' },
  { id: 'mean', header: 'Mean' },
  { id: 'scope', header: 'Scope' },
  { id: 'prov', header: 'Model · SHA' }
]
const caseColumns: TableColumn<EvalCaseListItem>[] = [
  { id: 'enabled', header: 'On' },
  { accessorKey: 'slug', header: 'Case' },
  { id: 'kind', header: 'Kind' },
  { accessorKey: 'nRuns', header: 'n' },
  { id: 'edit', header: '' }
]

// ── Enable toggles ────────────────────────────────────────────────────────
const { setEnabled, runSuite } = useEvalActions()
async function toggle(c: EvalCaseListItem, enabled: boolean) {
  try {
    await setEnabled.mutateAsync({ id: c.id, enabled })
  } catch (e) {
    toast.add({ color: 'error', title: `Could not ${enabled ? 'enable' : 'disable'} ${c.slug}`, description: evalErrorOf(e).message })
  }
}

// ── Run ───────────────────────────────────────────────────────────────────
const runOpen = ref(false)
const runCases = ref<string[]>([])
// UInput type=number emits a number (or '' when cleared) — always read it through nOverride().
const runN = ref<string>('')
const nOverride = (): number | undefined => (String(runN.value ?? '').trim() ? Number(runN.value) : undefined)
const runError = ref<string | null>(null)
const slugItems = computed(() => cases.value.map(c => ({ label: c.enabled ? c.slug : `${c.slug} (disabled)`, value: c.slug })))
const plannedAttempts = computed(() => {
  const chosen = runCases.value.length ? cases.value.filter(c => runCases.value.includes(c.slug)) : cases.value.filter(c => c.enabled)
  const n = nOverride()
  return chosen.reduce((sum, c) => sum + (n !== undefined && Number.isInteger(n) && n > 0 ? n : c.nRuns), 0)
})
function openRun() {
  runCases.value = []
  runN.value = ''
  runError.value = null
  runOpen.value = true
}
async function startRun() {
  runError.value = null
  const n = nOverride()
  if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 20)) {
    runError.value = 'Attempts must be a whole number from 1 to 20.'
    return
  }
  try {
    const run = await runSuite.mutateAsync({ suiteId: id.value, ...(runCases.value.length ? { cases: runCases.value } : {}), ...(n ? { n } : {}) })
    runOpen.value = false
    await navigateTo(`/evals/runs/${run.id}`)
  } catch (e) {
    runError.value = evalErrorOf(e).message
  }
}

async function exportJson() {
  try {
    await downloadSuiteJson(id.value)
  } catch (e) {
    toast.add({ color: 'error', title: 'Export failed', description: evalErrorOf(e).message })
  }
}
</script>

<template>
  <UDashboardPanel
    id="eval-suite-panel"
    grow
  >
    <template #header>
      <UDashboardNavbar :title="data?.suite.name ?? 'Eval suite'">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UButton
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="ghost"
            size="xs"
            to="/evals"
            aria-label="All suites"
          />
        </template>
        <template #right>
          <UButton
            icon="i-lucide-download"
            size="xs"
            color="neutral"
            variant="subtle"
            label="Export"
            data-testid="eval-export"
            @click="exportJson"
          />
          <UButton
            icon="i-lucide-play"
            size="xs"
            color="primary"
            label="Run"
            :disabled="!cases.length"
            data-testid="eval-run-open"
            @click="openRun"
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
      <template v-else-if="data">
        <p
          v-if="data.suite.description"
          class="text-sm text-muted"
        >
          {{ data.suite.description }}
        </p>

        <UCard class="shrink-0">
          <template #header>
            <span class="text-sm font-medium text-highlighted">Run history</span>
          </template>
          <EvalsRunHistoryChart :runs="runs" />
        </UCard>

        <UCard
          class="shrink-0"
          :ui="{ body: 'p-0 sm:p-0' }"
        >
          <template #header>
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm font-medium text-highlighted">Runs</span>
              <UButton
                size="xs"
                color="neutral"
                variant="subtle"
                icon="i-lucide-git-compare"
                :label="picked.length === 2 ? 'Compare the two' : `Pick two to compare (${picked.length}/2)`"
                :disabled="picked.length !== 2"
                data-testid="eval-compare"
                @click="compare"
              />
            </div>
          </template>
          <UTable
            :data="runs"
            :columns="runColumns"
            data-testid="eval-runs-table"
          >
            <template #pick-cell="{ row }">
              <UCheckbox
                :model-value="picked.includes(row.original.id)"
                :aria-label="`Pick run for comparison`"
                :data-testid="`eval-pick-${row.original.id}`"
                @update:model-value="(v: boolean | 'indeterminate') => togglePick(row.original.id, v === true)"
              />
            </template>
            <template #status-cell="{ row }">
              <NuxtLink
                :to="`/evals/runs/${row.original.id}`"
                class="inline-flex items-center gap-2"
                :data-testid="`eval-run-link-${row.original.id}`"
              >
                <EvalsRunStatusBadge :status="row.original.status" />
                <span
                  v-if="row.original.status === 'running'"
                  class="text-xs text-info"
                >{{ runProgress(row.original).done }}/{{ runProgress(row.original).planned ?? '?' }}</span>
              </NuxtLink>
            </template>
            <template #started-cell="{ row }">
              <NuxtLink
                :to="`/evals/runs/${row.original.id}`"
                class="text-sm hover:underline"
              >{{ formatAgo(row.original.startedAt) }}</NuxtLink>
            </template>
            <template #rate-cell="{ row }">
              <span class="font-medium">{{ pct(row.original.summary?.nonHoldout.passRate) }}</span>
              <span
                v-if="row.original.summary"
                class="ms-1 text-xs text-muted"
              >{{ row.original.summary.nonHoldout.passed }}/{{ row.original.summary.nonHoldout.cases }}</span>
            </template>
            <template #mean-cell="{ row }">
              {{ score(row.original.summary?.nonHoldout.meanScore) }}
            </template>
            <template #scope-cell="{ row }">
              <span class="text-xs text-muted">
                {{ row.original.params.cases?.length ? `${row.original.params.cases.length} case(s)` : 'all enabled' }}<template v-if="row.original.params.n"> · n={{ row.original.params.n }}</template>
              </span>
            </template>
            <template #prov-cell="{ row }">
              <span class="text-xs text-muted">{{ row.original.modelLabel ?? '—' }} · <code>{{ row.original.gitSha?.slice(0, 7) ?? '—' }}</code></span>
            </template>
            <template #empty>
              <p class="py-4 text-center text-sm text-muted">
                No runs yet.
              </p>
            </template>
          </UTable>
        </UCard>

        <UCard
          class="shrink-0"
          :ui="{ body: 'p-0 sm:p-0' }"
        >
          <template #header>
            <span class="text-sm font-medium text-highlighted">Cases ({{ cases.filter(c => c.enabled).length }} of {{ cases.length }} enabled)</span>
          </template>
          <UTable
            :data="cases"
            :columns="caseColumns"
            data-testid="eval-cases-table"
          >
            <template #enabled-cell="{ row }">
              <USwitch
                :model-value="row.original.enabled"
                size="sm"
                :aria-label="`Enable ${row.original.slug}`"
                :data-testid="`eval-case-toggle-${row.original.slug}`"
                @update:model-value="(v: boolean) => toggle(row.original, v)"
              />
            </template>
            <template #slug-cell="{ row }">
              <NuxtLink
                :to="`/evals/cases/${row.original.id}`"
                class="font-medium text-highlighted hover:underline"
                :class="row.original.enabled ? '' : 'opacity-60'"
              >{{ row.original.slug }}</NuxtLink>
              <p class="max-w-lg truncate text-xs text-muted">
                {{ row.original.prompt }}
              </p>
            </template>
            <template #kind-cell="{ row }">
              <div class="flex flex-wrap gap-1">
                <UBadge
                  color="neutral"
                  variant="subtle"
                  size="xs"
                  :label="row.original.surface"
                />
                <UBadge
                  v-if="row.original.holdout"
                  color="secondary"
                  variant="subtle"
                  size="xs"
                  label="holdout"
                />
                <UBadge
                  v-if="row.original.hasRubric"
                  color="info"
                  variant="subtle"
                  size="xs"
                  label="rubric"
                />
              </div>
            </template>
            <template #edit-cell="{ row }">
              <UButton
                :to="`/evals/cases/${row.original.id}`"
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-pencil"
                :aria-label="`Edit ${row.original.slug}`"
              />
            </template>
          </UTable>
        </UCard>
      </template>

      <UModal
        v-model:open="runOpen"
        title="Run the suite"
        description="Runs on the agent worker against the fake world. Each attempt is a real model run."
      >
        <template #body>
          <div class="flex flex-col gap-4">
            <UFormField
              label="Cases"
              help="Leave empty to run every enabled case."
            >
              <USelectMenu
                v-model="runCases"
                :items="slugItems"
                value-key="value"
                multiple
                placeholder="All enabled cases"
                class="w-full"
                data-testid="eval-run-cases"
              />
            </UFormField>
            <UFormField
              label="Attempts per case"
              help="Leave empty to use each case's own n."
            >
              <UInput
                v-model="runN"
                type="number"
                min="1"
                max="20"
                placeholder="each case's n"
                data-testid="eval-run-n"
              />
            </UFormField>
            <p class="text-sm text-muted">
              {{ plannedAttempts }} attempt(s) in total.
            </p>
            <UAlert
              v-if="runError"
              color="error"
              variant="subtle"
              icon="i-lucide-circle-alert"
              :title="runError"
              data-testid="eval-run-error"
            />
          </div>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              label="Cancel"
              @click="runOpen = false"
            />
            <UButton
              color="primary"
              icon="i-lucide-play"
              label="Start run"
              :loading="runSuite.isPending.value"
              :disabled="!plannedAttempts"
              data-testid="eval-run-submit"
              @click="startRun"
            />
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
