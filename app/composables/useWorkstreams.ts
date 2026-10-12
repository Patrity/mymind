// Cycle 81 Task 6: workstreams (spec §5.5) — live reads keyed for the `workstream` resource
// (default dispatch invalidates ['workstream', id] + ['workstream', 'list']), the controls (each a
// round trip to the agent worker), and the worker heartbeat the offline banner reads.
import type { MaybeRefOrGetter } from 'vue'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/vue-query'
import { CHILDREN_PAGE_MAX, type WorkstreamBudget, type WorkstreamDTO } from '@mymind/core/shared/types/workstreams'
import type { SandboxHealth } from '@mymind/core/shared/types/workspaces'

/** The readable text of a failed workstream request (the routes put it in `data.message`; h3
 *  strips non-ASCII from statusMessage). */
export function workstreamErrorOf(e: unknown): { message: string; code: string | null } {
  const err = e as { data?: { data?: { message?: string; code?: string }; statusMessage?: string }; message?: string }
  return {
    message: err?.data?.data?.message ?? err?.data?.statusMessage ?? err?.message ?? 'Something went wrong',
    code: err?.data?.data?.code ?? null
  }
}

export function useWorkstreamList() {
  return useQuery({
    queryKey: ['workstream', 'list'] as const,
    queryFn: () => $fetch<WorkstreamDTO[]>('/api/workstreams')
  })
}

export function useWorkstream(id: MaybeRefOrGetter<string | null | undefined>) {
  const key = computed(() => toValue(id) ?? '')
  return useQuery({
    queryKey: computed(() => ['workstream', key.value] as const),
    queryFn: () => $fetch<WorkstreamDTO>(`/api/workstreams/${key.value}`),
    enabled: computed(() => !!key.value)
  })
}

/** Cycle 83: a coordinator's children, oldest first. Keyed under ['workstream', 'list'] so the
 *  default live dispatch (which invalidates that prefix on every workstream change) refreshes it
 *  when any child moves — a child's change publishes the CHILD's id, not the coordinator's. */
export function useWorkstreamChildren(id: MaybeRefOrGetter<string | null | undefined>, enabled: MaybeRefOrGetter<boolean> = true) {
  const key = computed(() => toValue(id) ?? '')
  return useQuery({
    queryKey: computed(() => childrenKey(key.value)),
    queryFn: () => fetchAllChildren(key.value),
    enabled: computed(() => !!key.value && toValue(enabled))
  })
}

/** The same (shared-cache) query for several coordinators at once — the list's "+N more". */
export function useWorkstreamChildrenOf(ids: MaybeRefOrGetter<string[]>) {
  return useQueries({
    queries: computed(() => toValue(ids).map(id => ({ queryKey: childrenKey(id), queryFn: () => fetchAllChildren(id) })))
  })
}

const childrenKey = (id: string) => ['workstream', 'list', 'children', id] as const

/** Every child of a coordinator, oldest first, a page (≤ CHILDREN_PAGE_MAX) per request. */
async function fetchAllChildren(id: string): Promise<WorkstreamDTO[]> {
  const out: WorkstreamDTO[] = []
  for (;;) {
    const page = await $fetch<WorkstreamDTO[]>(`/api/workstreams/${id}/children`, { query: { limit: CHILDREN_PAGE_MAX, offset: out.length } })
    out.push(...page)
    if (page.length < CHILDREN_PAGE_MAX) return out
  }
}

export function useWorkstreamActions() {
  const qc = useQueryClient()
  const settle = (dto: WorkstreamDTO) => {
    qc.setQueryData(['workstream', dto.id], dto)
    void qc.invalidateQueries({ queryKey: ['workstream', 'list'] })
  }
  const start = useMutation({
    mutationFn: (b: { goal: string; budget?: Partial<WorkstreamBudget> }) =>
      $fetch<WorkstreamDTO>('/api/workstreams', { method: 'POST', body: b }),
    onSuccess: settle
  })
  const control = useMutation({
    mutationFn: (p: { id: string; action: 'cancel' | 'resume' | 'steer'; text?: string }) =>
      $fetch<WorkstreamDTO>(`/api/workstreams/${p.id}/${p.action}`, { method: 'POST', body: p.action === 'steer' ? { text: p.text } : {} }),
    onSuccess: settle
  })
  return { start, control }
}

/**
 * The agent worker's heartbeat (spec §6): offline when its newest beat is > 30s old. Polled — the
 * heartbeat is a timestamp, not a change anything publishes. Unknown (null) until the first read,
 * and a failed read is NOT "offline" (the web itself may be what is down).
 */
export function useWorkerStatus() {
  const { data } = useQuery({
    queryKey: ['agent', 'worker'] as const,
    queryFn: () => $fetch<{ online: boolean; beatAt: string | null; sandbox: SandboxHealth | null }>('/api/agent/worker'),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false
  })
  const offline = computed(() => data.value?.online === false)
  const beatAt = computed(() => data.value?.beatAt ?? null)
  // Cycle 82 final review I6: why the worker's sandbox preflight failed (null = fine / unknown). Only
  // from a live worker — an offline one has its own banner.
  const sandboxProblem = computed(() => {
    const s = data.value?.sandbox
    return data.value?.online && s && !s.ok ? s.reason : null
  })
  return { offline, beatAt, sandboxProblem }
}
