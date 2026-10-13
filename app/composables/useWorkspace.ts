// Cycle 82 Task 3: a workspace's Files / Shells views. Live reads keyed under the `workspace`
// resource (the default dispatch invalidates ['workspace', id] — a prefix of every key here — when
// the row, a shell or the usage changes). Every file/shell read is a round trip to the agent worker,
// which reads inside the sandbox.
import type { MaybeRefOrGetter } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { WorkspaceDTO, WorkspaceFileView, WorkspaceShellDTO, WorkspaceShellTail, WorkspaceTree } from '@mymind/core/shared/types/workspaces'

/** The readable text of a failed workspace request (routes put it in `data.message`). */
export function workspaceErrorOf(e: unknown): string {
  const err = e as { data?: { data?: { message?: string }; statusMessage?: string }; message?: string }
  return err?.data?.data?.message ?? err?.data?.statusMessage ?? err?.message ?? 'Something went wrong'
}

/** `idOrHome`: a workspace uuid or `home`. Resolves to the row (its real id keys the rest). */
export function useWorkspace(idOrHome: MaybeRefOrGetter<string | null | undefined>) {
  const key = computed(() => toValue(idOrHome) ?? '')
  return useQuery({
    queryKey: computed(() => ['workspace', key.value] as const),
    queryFn: () => $fetch<WorkspaceDTO>(`/api/workspaces/${key.value}`),
    enabled: computed(() => !!key.value)
  })
}

export function useWorkstreamWorkspace(workstreamId: MaybeRefOrGetter<string | null | undefined>) {
  const key = computed(() => toValue(workstreamId) ?? '')
  return useQuery({
    queryKey: computed(() => ['workstream', key.value, 'workspace'] as const),
    queryFn: () => $fetch<WorkspaceDTO>(`/api/workstreams/${key.value}/workspace`),
    enabled: computed(() => !!key.value),
    retry: false
  })
}

export function useWorkspaceTree(id: MaybeRefOrGetter<string | null | undefined>) {
  const key = computed(() => toValue(id) ?? '')
  return useQuery({
    queryKey: computed(() => ['workspace', key.value, 'files'] as const),
    queryFn: () => $fetch<WorkspaceTree>(`/api/workspaces/${key.value}/files`),
    enabled: computed(() => !!key.value),
    retry: false
  })
}

export function useWorkspaceFile(id: MaybeRefOrGetter<string | null | undefined>, path: MaybeRefOrGetter<string | null | undefined>) {
  const ws = computed(() => toValue(id) ?? '')
  const p = computed(() => toValue(path) ?? '')
  return useQuery({
    queryKey: computed(() => ['workspace', ws.value, 'file', p.value] as const),
    queryFn: () => $fetch<WorkspaceFileView>(`/api/workspaces/${ws.value}/file`, { query: { path: p.value } }),
    enabled: computed(() => !!ws.value && !!p.value),
    retry: false
  })
}

export function useWorkspaceShells(id: MaybeRefOrGetter<string | null | undefined>) {
  const key = computed(() => toValue(id) ?? '')
  return useQuery({
    queryKey: computed(() => ['workspace', key.value, 'shells'] as const),
    queryFn: () => $fetch<WorkspaceShellDTO[]>(`/api/workspaces/${key.value}/shells`),
    enabled: computed(() => !!key.value)
  })
}

/** A shell's output tail; polled every 3s while it runs (output growth publishes nothing). */
export function useShellTail(id: MaybeRefOrGetter<string | null | undefined>, shellId: MaybeRefOrGetter<string | null | undefined>, running: MaybeRefOrGetter<boolean>) {
  const ws = computed(() => toValue(id) ?? '')
  const sh = computed(() => toValue(shellId) ?? '')
  return useQuery({
    queryKey: computed(() => ['workspace', ws.value, 'shell', sh.value] as const),
    queryFn: () => $fetch<WorkspaceShellTail>(`/api/workspaces/${ws.value}/shells/${sh.value}/output`),
    enabled: computed(() => !!ws.value && !!sh.value),
    refetchInterval: computed(() => (toValue(running) ? 3000 : false)),
    retry: false
  })
}

export function useWorkspaceActions() {
  const qc = useQueryClient()
  const kill = useMutation({
    mutationFn: (p: { workspaceId: string; shellId: string }) =>
      $fetch<{ shellId: string; state: string; alreadyEnded: boolean }>(`/api/workspaces/${p.workspaceId}/shells/${p.shellId}/kill`, { method: 'POST' }),
    onSuccess: (_r, p) => { void qc.invalidateQueries({ queryKey: ['workspace', p.workspaceId] }) }
  })
  // Cycle 86 (option C): session-only — clears the workspace's taint flag (server/api/workspaces/[id]/trust.post.ts).
  const trust = useMutation({
    mutationFn: (workspaceId: string) => $fetch<WorkspaceDTO>(`/api/workspaces/${workspaceId}/trust`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workspace'] })
      // The workstream page reads it as ['workstream', id, 'workspace'].
      void qc.invalidateQueries({ predicate: q => q.queryKey[0] === 'workstream' && q.queryKey[2] === 'workspace' })
    }
  })
  return { kill, trust }
}
