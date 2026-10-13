<script setup lang="ts">
/**
 * /evals (cycle 85 spec §3.5): Bridget's eval suites — each with its newest run (live while it
 * runs), its non-holdout pass rate and the trend over its last finished runs. Import a suite from
 * its JSON here; export lives on the suite.
 */
import type { TableColumn } from '@nuxt/ui'
import type { EvalSuiteOverview } from '@mymind/core/shared/types/eval'
import { pct, runProgress, score } from '~/lib/evals/display'
import { formatAgo } from '~/lib/jobs/display'

definePageMeta({ title: 'Evals' })

const toast = useToast()
const { data, error, isPending } = useEvalSuites()
const suites = computed(() => data.value ?? [])
watch(error, (err) => {
  if (err) toast.add({ color: 'error', title: 'Could not load the eval suites', description: evalErrorOf(err).message })
})

const columns: TableColumn<EvalSuiteOverview>[] = [
  { accessorKey: 'name', header: 'Suite' },
  { id: 'cases', header: 'Cases' },
  { id: 'last', header: 'Last run' },
  { id: 'rate', header: 'Pass rate' },
  { id: 'trend', header: 'Trend' }
]

// ── Import ────────────────────────────────────────────────────────────────
const { importSuite } = useEvalActions()
const importOpen = ref(false)
const importText = ref('')
const importFile = ref<File | null>(null)
const replace = ref(false)
const importError = ref<{ message: string, issues: Array<{ path: Array<string | number>, message: string }> } | null>(null)
watch(importFile, async (f) => { if (f) importText.value = await f.text() })

function openImport() {
  importText.value = ''
  importFile.value = null
  replace.value = false
  importError.value = null
  importOpen.value = true
}

async function doImport() {
  importError.value = null
  let suite: unknown
  try {
    suite = JSON.parse(importText.value)
  } catch (e) {
    importError.value = { message: `Not valid JSON: ${(e as Error).message}`, issues: [] }
    return
  }
  try {
    const r = await importSuite.mutateAsync({ suite, replace: replace.value })
    importOpen.value = false
    toast.add({ color: 'success', title: 'Suite imported', description: `${r.created} added, ${r.updated} updated${r.removed ? `, ${r.removed} removed` : ''}.` })
    await navigateTo(`/evals/suites/${r.suiteId}`)
  } catch (e) {
    importError.value = evalErrorOf(e)
  }
}
</script>

<template>
  <UDashboardPanel
    id="evals-panel"
    grow
  >
    <template #header>
      <UDashboardNavbar title="Evals">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            icon="i-lucide-upload"
            size="xs"
            color="neutral"
            variant="subtle"
            label="Import suite"
            data-testid="eval-import-open"
            @click="openImport"
          />
        </template>
      </UDashboardNavbar>
      <AgentWorkerOfflineBanner />
    </template>

    <template #body>
      <p class="text-sm text-muted">
        Recorded scenarios Bridget runs against a fake world — real model, real tools, no real email,
        calendar or messages. Each attempt is scored on the actions she took, what she said, and (with a
        rubric) whether the outcome was met. Pass rates exclude holdout cases.
      </p>

      <UTable
        :data="suites"
        :columns="columns"
        :loading="isPending"
        data-testid="eval-suites-table"
      >
        <template #name-cell="{ row }">
          <NuxtLink
            :to="`/evals/suites/${row.original.id}`"
            class="font-medium text-highlighted hover:underline"
            :data-testid="`eval-suite-link-${row.original.name}`"
          >
            {{ row.original.name }}
          </NuxtLink>
          <p
            v-if="row.original.description"
            class="max-w-md truncate text-xs text-muted"
          >
            {{ row.original.description }}
          </p>
        </template>
        <template #cases-cell="{ row }">
          <span class="text-sm">{{ row.original.enabledCases }}</span>
          <span
            v-if="row.original.enabledCases !== row.original.cases"
            class="text-xs text-muted"
          > / {{ row.original.cases }}</span>
        </template>
        <template #last-cell="{ row }">
          <div
            v-if="row.original.lastRun"
            class="flex items-center gap-2"
          >
            <EvalsRunStatusBadge :status="row.original.lastRun.status" />
            <NuxtLink
              :to="`/evals/runs/${row.original.lastRun.id}`"
              class="text-xs text-muted hover:underline"
            >
              {{ formatAgo(row.original.lastRun.startedAt) }}
            </NuxtLink>
            <span
              v-if="row.original.lastRun.status === 'running'"
              class="text-xs text-info"
            >{{ runProgress(row.original.lastRun).done }}/{{ runProgress(row.original.lastRun).planned ?? '?' }}</span>
          </div>
          <span
            v-else
            class="text-xs text-dimmed"
          >never run</span>
        </template>
        <template #rate-cell="{ row }">
          <template v-if="row.original.trend.length">
            <span class="font-medium text-highlighted">{{ pct(row.original.trend.at(-1)!.passRate) }}</span>
            <span class="ms-1 text-xs text-muted">mean {{ score(row.original.trend.at(-1)!.meanScore) }}</span>
          </template>
          <span
            v-else
            class="text-xs text-dimmed"
          >—</span>
        </template>
        <template #trend-cell="{ row }">
          <EvalsSparkline :values="row.original.trend.map(p => p.passRate)" />
        </template>
        <template #empty>
          <p class="py-6 text-center text-sm text-muted">
            No suites yet. The worker seeds the built-in <code>bridget-core</code> suite when it starts; you can also import one.
          </p>
        </template>
      </UTable>

      <UModal
        v-model:open="importOpen"
        title="Import a suite"
        description="Paste or drop a suite's JSON (the export format). Cases are upserted by slug; the suite by name."
      >
        <template #body>
          <div class="flex flex-col gap-3">
            <UFileUpload
              v-model="importFile"
              accept="application/json,.json"
              icon="i-lucide-file-json"
              label="Drop a .json file"
              class="min-h-24"
            />
            <UTextarea
              v-model="importText"
              :rows="10"
              autoresize
              :maxrows="18"
              placeholder="{ &quot;name&quot;: &quot;my-suite&quot;, &quot;cases&quot;: [ … ] }"
              class="font-mono"
              data-testid="eval-import-text"
            />
            <UCheckbox
              v-model="replace"
              label="Replace: also delete this suite's cases the JSON doesn't have"
            />
            <UAlert
              v-if="importError"
              color="error"
              variant="subtle"
              icon="i-lucide-circle-alert"
              title="Not imported"
              data-testid="eval-import-error"
            >
              <template #description>
                <p class="whitespace-pre-wrap break-words">
                  {{ importError.issues.length ? `${importError.issues.length} problem(s):` : importError.message }}
                </p>
                <ul
                  v-if="importError.issues.length"
                  class="mt-1 list-disc ps-4 text-sm"
                >
                  <li
                    v-for="(iss, k) in importError.issues.slice(0, 20)"
                    :key="k"
                  >
                    <code>{{ iss.path.join('.') || '(root)' }}</code>: {{ iss.message }}
                  </li>
                </ul>
              </template>
            </UAlert>
          </div>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              label="Cancel"
              @click="importOpen = false"
            />
            <UButton
              color="primary"
              label="Import"
              :loading="importSuite.isPending.value"
              :disabled="!importText.trim()"
              data-testid="eval-import-submit"
              @click="doImport"
            />
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
