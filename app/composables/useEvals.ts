// Cycle 85 Task 4 (spec §3.5): the /evals dashboard's data — every query keyed under ['eval', …],
// which the `eval` live resource invalidates as a whole (app/utils/live-dispatch.ts), so a run's
// progress, a case edit or an import shows up on every open page without a refresh.
import type { MaybeRefOrGetter } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import type {
  EvalAttemptView, EvalCaseView, EvalRunDTO, EvalRunParams, EvalRunView, EvalSuiteDetail, EvalSuiteOverview
} from '@mymind/core/shared/types/eval'
import type { FieldIssue } from '~/lib/evals/display'

/** The readable text (and field issues) of a failed /api/evals request (they ride in `data`). */
export function evalErrorOf(e: unknown): { message: string, code: string | null, issues: FieldIssue[] } {
  const err = e as { data?: { data?: { message?: string, code?: string, issues?: FieldIssue[] }, statusMessage?: string }, message?: string }
  return {
    message: err?.data?.data?.message ?? err?.data?.statusMessage ?? err?.message ?? 'Something went wrong',
    code: err?.data?.data?.code ?? null,
    issues: err?.data?.data?.issues ?? []
  }
}

function byId<T>(kind: string, id: MaybeRefOrGetter<string | null | undefined>, url: (id: string) => string) {
  const key = computed(() => toValue(id) ?? '')
  return useQuery({
    queryKey: computed(() => ['eval', kind, key.value] as const),
    queryFn: () => $fetch<T>(url(key.value)),
    enabled: computed(() => !!key.value)
  })
}

export function useEvalSuites() {
  return useQuery({ queryKey: ['eval', 'suites'] as const, queryFn: () => $fetch<EvalSuiteOverview[]>('/api/evals/suites') })
}
export const useEvalSuite = (id: MaybeRefOrGetter<string | null | undefined>) => byId<EvalSuiteDetail>('suite', id, i => `/api/evals/suites/${i}`)
export const useEvalRun = (id: MaybeRefOrGetter<string | null | undefined>) => byId<EvalRunView>('run', id, i => `/api/evals/runs/${i}`)
export const useEvalAttempt = (id: MaybeRefOrGetter<string | null | undefined>) => byId<EvalAttemptView>('attempt', id, i => `/api/evals/results/${i}`)
export const useEvalCase = (id: MaybeRefOrGetter<string | null | undefined>) => byId<EvalCaseView>('case', id, i => `/api/evals/cases/${i}`)

export function useEvalActions() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['eval'] })
  const runSuite = useMutation({
    mutationFn: (p: { suiteId: string } & EvalRunParams) => {
      const { suiteId, ...params } = p
      return $fetch<EvalRunDTO>(`/api/evals/suites/${suiteId}/runs`, { method: 'POST', body: params })
    },
    onSuccess: refresh
  })
  const cancelRun = useMutation({
    mutationFn: (runId: string) => $fetch<{ cancelled: boolean }>(`/api/evals/runs/${runId}/cancel`, { method: 'POST' }),
    onSuccess: refresh
  })
  const saveCase = useMutation({
    mutationFn: (p: { id: string, json: unknown }) => $fetch<EvalCaseView>(`/api/evals/cases/${p.id}`, { method: 'PUT', body: p.json as Record<string, unknown> }),
    onSuccess: (view) => { qc.setQueryData(['eval', 'case', view.id], view); void refresh() }
  })
  const setEnabled = useMutation({
    mutationFn: (p: { id: string, enabled: boolean }) => $fetch<{ id: string, enabled: boolean }>(`/api/evals/cases/${p.id}`, { method: 'PATCH', body: { enabled: p.enabled } }),
    onSuccess: refresh
  })
  const importSuite = useMutation({
    mutationFn: (p: { suite: unknown, replace?: boolean }) =>
      $fetch<{ suiteId: string, created: number, updated: number, removed: number }>('/api/evals/suites/import', { method: 'POST', body: { suite: p.suite, replace: p.replace === true } }),
    onSuccess: refresh
  })
  return { runSuite, cancelRun, saveCase, setEnabled, importSuite }
}

/** Downloads a suite's JSON (the import format) as `<name>.json`. */
export async function downloadSuiteJson(suiteId: string): Promise<void> {
  const json = await $fetch<{ name: string }>(`/api/evals/suites/${suiteId}/export`)
  const blob = new Blob([JSON.stringify(json, null, 2) + '\n'], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${json.name.replace(/[^\w.-]+/g, '-')}.json`
  a.click()
  URL.revokeObjectURL(url)
}
