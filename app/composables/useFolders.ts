import { $fetch as ofetch } from 'ofetch'
import type { FolderDTO } from '~~/shared/types/folders'

export interface FolderImpact {
  documents: number
  // Deliberately distinct from `remove()`'s `foldersDeleted` below — this counts only what's
  // INSIDE the folder (see `folderImpact()` in server/services/folders.ts), which differs by
  // exactly one from a delete's count (the folder itself). Collapsing the two to one name
  // would let a confirm dialog and the toast that follows it show numbers off by one against
  // each other with nothing in the types to catch it — keep them separate on purpose.
  foldersInside: number
  projectChanges: { from: string | null, to: string | null, count: number }[]
}

/**
 * Thin HTTP wrapper over `/api/folders/**` — no caching, no local state. Task 15 converts
 * these calls to optimistic vue-query mutations, so this stays a plain fetch layer with
 * nothing for that migration to unwind.
 */
export function useFolders() {
  const create = (path: string) =>
    ofetch<FolderDTO>('/api/folders', { method: 'POST', body: { path } })

  const patch = (id: string, body: { path?: string, color?: string | null }) =>
    ofetch<{ ok: true }>(`/api/folders/${id}`, { method: 'PATCH', body })

  // `DELETE /api/folders/[id]` returns `{ documents, foldersDeleted }` — `foldersDeleted`
  // counts the folder ITSELF too, deliberately distinct from `impact()`'s `foldersInside`
  // below (see server/services/folders.ts). Kept as its own name rather than normalised to
  // a shared `folders` field, so the two can never be swapped by accident at a call site.
  const remove = (id: string) =>
    ofetch<{ documents: number, foldersDeleted: number }>(`/api/folders/${id}`, { method: 'DELETE' })

  const impact = (id: string, to?: string) =>
    ofetch<FolderImpact>(`/api/folders/${id}/impact`, { query: to ? { to } : undefined })

  return { create, patch, remove, impact }
}
