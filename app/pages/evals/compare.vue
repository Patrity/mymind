<script setup lang="ts">
/**
 * /evals/compare?a=&b= (spec §3.5): two runs side by side — per-case mean score and pass, the delta
 * (B − A) and what changed (fixed / regressed / better / worse), plus what differs in provenance
 * (git SHA, model, prompt and tools hashes; per case, whether its assembled prompt changed).
 */
import type { TableColumn } from '@nuxt/ui'
import { CHANGE_META, compareRuns, pct, score, signed, type CompareRow } from '~/lib/evals/display'
import { formatAgo } from '~/lib/jobs/display'

definePageMeta({ title: 'Compare eval runs' })

const route = useRoute()
const toast = useToast()
const aId = computed(() => (typeof route.query.a === 'string' ? route.query.a : null))
const bId = computed(() => (typeof route.query.b === 'string' ? route.query.b : null))
const { data: a, error: aErr } = useEvalRun(aId)
const { data: b, error: bErr } = useEvalRun(bId)
watch([aErr, bErr], ([x, y]) => {
  const err = x ?? y
  if (err) toast.add({ color: 'error', title: 'Could not load a run', description: evalErrorOf(err).message })
})
const cmp = computed(() => (a.value && b.value ? compareRuns(a.value.run, b.value.run) : null))
const changed = computed(() => (cmp.value?.cases ?? []).filter(c => c.change !== 'same').length)

// The other runs of A's suite, to swap either side.
const { data: suite } = useEvalSuite(() => a.value?.suite.id ?? null)
const runItems = computed(() => (suite.value?.runs ?? []).map(r => ({
  label: `${formatAgo(r.startedAt)} · ${r.status} · ${pct(r.summary?.nonHoldout.passRate)}`,
  value: r.id
})))
function pick(side: 'a' | 'b', v: string) {
  void navigateTo({ path: '/evals/compare', query: { ...route.query, [side]: v } })
}

const columns: TableColumn<CompareRow>[] = [
  { accessorKey: 'slug', header: 'Case' },
  { id: 'a', header: 'A' },
  { id: 'b', header: 'B' },
  { id: 'delta', header: 'Δ mean' },
  { id: 'change', header: 'Change' }
]
// Hashes / SHAs are shortened (full value on hover); the model label is shown whole.
const short = (field: string, v: string | null) => (v === null ? '—' : field === 'Model' ? v : v.slice(0, 16))
const deltaClass = (d: number | null) => (d === null || Math.abs(d) < 1e-9 ? 'text-muted' : d > 0 ? 'text-success' : 'text-error')
</script>

<template>
  <UDashboardPanel
    id="eval-compare-panel"
    grow
  >
    <template #header>
      <UDashboardNavbar title="Compare runs">
        <template #leading>
          <UDashboardSidebarCollapse />
          <UButton
            v-if="a"
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="ghost"
            size="xs"
            :to="`/evals/suites/${a.suite.id}`"
            aria-label="Back to the suite"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UAlert class="shrink-0"
        v-if="!aId || !bId"
        color="neutral"
        variant="subtle"
        title="Pick two runs on a suite's page to compare them."
      />
      <template v-else-if="a && b && cmp">
        <div class="grid gap-3 md:grid-cols-2">
          <UCard
            v-for="side in (['a', 'b'] as const)"
            :key="side"
            class="shrink-0"
            :ui="{ body: 'p-3 sm:p-3' }"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm font-semibold text-highlighted">{{ side.toUpperCase() }}</span>
              <USelectMenu
                :model-value="side === 'a' ? aId : bId"
                :items="runItems"
                value-key="value"
                size="xs"
                class="w-64"
                :data-testid="`eval-compare-pick-${side}`"
                @update:model-value="(v: string) => pick(side, v)"
              />
            </div>
            <div class="mt-2 flex items-baseline gap-3">
              <NuxtLink
                :to="`/evals/runs/${(side === 'a' ? a : b).run.id}`"
                class="text-2xl font-semibold text-highlighted hover:underline"
              >{{ pct((side === 'a' ? a : b).run.summary?.nonHoldout.passRate) }}</NuxtLink>
              <span class="text-sm text-muted">mean {{ score((side === 'a' ? a : b).run.summary?.nonHoldout.meanScore) }} · {{ formatAgo((side === 'a' ? a : b).run.startedAt) }}</span>
            </div>
          </UCard>
        </div>

        <div
          class="flex flex-wrap gap-4 text-sm"
          data-testid="eval-compare-headline"
        >
          <span>Pass rate Δ <strong :class="deltaClass(cmp.nonHoldout.delta)">{{ cmp.nonHoldout.delta === null ? '—' : `${signed(cmp.nonHoldout.delta * 100, 0)} pts` }}</strong></span>
          <span>Mean Δ <strong :class="deltaClass(cmp.meanScore.delta)">{{ signed(cmp.meanScore.delta) }}</strong></span>
          <span class="text-muted">{{ changed }} of {{ cmp.cases.length }} case(s) changed</span>
        </div>

        <UCard
          class="shrink-0"
          data-testid="eval-compare-provenance"
        >
          <template #header>
            <span class="text-sm font-medium text-highlighted">Provenance</span>
          </template>
          <div class="grid grid-cols-[auto_1fr_1fr] gap-x-4 gap-y-1 text-sm">
            <span class="text-xs text-muted" />
            <span class="text-xs text-muted">A</span>
            <span class="text-xs text-muted">B</span>
            <template
              v-for="p in cmp.provenance"
              :key="p.field"
            >
              <span class="text-muted">{{ p.field }}</span>
              <code
                class="truncate"
                :title="p.a ?? ''"
              >{{ short(p.field, p.a) }}</code>
              <span class="flex items-center gap-1.5">
                <code
                  class="truncate"
                  :class="p.same ? '' : 'text-warning'"
                  :title="p.b ?? ''"
                >{{ short(p.field, p.b) }}</code>
                <UBadge
                  v-if="!p.same"
                  color="warning"
                  variant="subtle"
                  size="xs"
                  label="differs"
                  :data-testid="`eval-prov-differs-${p.field}`"
                />
              </span>
            </template>
          </div>
        </UCard>

        <UCard
          class="shrink-0"
          :ui="{ body: 'p-0 sm:p-0' }"
        >
          <UTable
            :data="cmp.cases"
            :columns="columns"
            data-testid="eval-compare-table"
          >
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
              <UTooltip
                v-if="row.original.promptChanged"
                text="The assembled system prompt for this case differs between the runs"
              >
                <UBadge
                  color="warning"
                  variant="subtle"
                  size="xs"
                  label="prompt changed"
                  class="ms-1"
                />
              </UTooltip>
            </template>
            <template #a-cell="{ row }">
              <span v-if="row.original.a">{{ score(row.original.a.mean) }} <UIcon
                :name="row.original.a.passed ? 'i-lucide-check' : 'i-lucide-x'"
                :class="row.original.a.passed ? 'text-success' : 'text-error'"
                class="size-3.5 align-middle"
              /></span>
              <span
                v-else
                class="text-dimmed"
              >—</span>
            </template>
            <template #b-cell="{ row }">
              <span v-if="row.original.b">{{ score(row.original.b.mean) }} <UIcon
                :name="row.original.b.passed ? 'i-lucide-check' : 'i-lucide-x'"
                :class="row.original.b.passed ? 'text-success' : 'text-error'"
                class="size-3.5 align-middle"
              /></span>
              <span
                v-else
                class="text-dimmed"
              >—</span>
            </template>
            <template #delta-cell="{ row }">
              <span
                :class="deltaClass(row.original.delta)"
                :data-testid="`eval-delta-${row.original.slug}`"
              >{{ signed(row.original.delta) }}</span>
            </template>
            <template #change-cell="{ row }">
              <UBadge
                :color="CHANGE_META[row.original.change].color"
                variant="subtle"
                size="sm"
                :label="CHANGE_META[row.original.change].label"
              />
            </template>
          </UTable>
        </UCard>
      </template>
      <USkeleton
        v-else
        class="h-40"
      />
    </template>
  </UDashboardPanel>
</template>
