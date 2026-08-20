import { $fetch as ofetch } from 'ofetch'
import { useQuery } from '@tanstack/vue-query'
import type { TaskColumnDTO, TaskColumnKind, TaskColumnColor } from '~~/shared/types/task-columns'

export function useTaskColumns() {
  const list = () => ofetch<TaskColumnDTO[]>('/api/task-columns')

  const create = (body: { name: string, kind: TaskColumnKind, color: TaskColumnColor, position?: number }) =>
    ofetch<TaskColumnDTO>('/api/task-columns', { method: 'POST', body })

  const update = (id: string, body: { name?: string, color?: TaskColumnColor }) =>
    ofetch<TaskColumnDTO>(`/api/task-columns/${id}`, { method: 'PATCH', body })

  const remove = (id: string, body: { mode: 'delete' | 'reassign', targetColumnId?: string }) =>
    ofetch<{ ok: boolean, reason?: string, affected: number }>(`/api/task-columns/${id}`, { method: 'DELETE', body })

  const reorder = (ids: string[]) =>
    ofetch<{ ok: boolean }>('/api/task-columns/reorder', { method: 'POST', body: { ids } })

  // One global list — columns aren't scoped per-project, so there's no filter param (unlike
  // useTaskList). Server orders by `position`; consumers must render that order as-is, never
  // re-sort client-side (see app/pages/tasks.vue).
  //
  // Column mutations publish `resource: 'task'` on the live bus rather than a dedicated
  // `taskColumn` member of ResourceName (see server/services/task-columns.ts's rationale
  // comment) — the default SSE dispatch invalidates `['task', id]` and `['task','list']`,
  // neither of which reaches this `['task-columns','list']` key. That's fine for now: nothing
  // in this cycle mutates a column from the UI yet (Task 9), and when it does, the mutating
  // component calls this query's own refetch() explicitly after the write — the same pattern
  // useTasks.ts's own mutations use (see tasks.vue's submitNew/submitEdit/deleteTask).
  const useColumnList = () => useQuery({
    queryKey: ['task-columns', 'list'],
    queryFn: list
  })

  return { list, create, update, remove, reorder, useColumnList }
}
