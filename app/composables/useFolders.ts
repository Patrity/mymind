import { $fetch as ofetch } from 'ofetch'
import type { FolderDTO } from '~~/shared/types/folders'

export interface FolderImpact {
  documents: number
  folders: number
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

  // `DELETE /api/folders/[id]` returns `{ documents, foldersDeleted }` (deliberately distinct
  // from `folderImpact()`'s `foldersInside`, which counts only what's INSIDE — see
  // server/services/folders.ts). Remapped to `folders` here so this composable's public
  // shape matches `impact()`'s below and the mismatch lives in one place, not every call site.
  const remove = async (id: string) => {
    const r = await ofetch<{ documents: number, foldersDeleted: number }>(`/api/folders/${id}`, { method: 'DELETE' })
    return { documents: r.documents, folders: r.foldersDeleted }
  }

  // The service's `folderImpact()` names the count `foldersInside`. Remapped here to the
  // `folders` name this composable's consumers (Task 12's dialogs) are documented to expect.
  const impact = async (id: string, to?: string) => {
    const r = await ofetch<{ documents: number, foldersInside: number, projectChanges: FolderImpact['projectChanges'] }>(
      `/api/folders/${id}/impact`,
      { query: to ? { to } : undefined }
    )
    return { documents: r.documents, folders: r.foldersInside, projectChanges: r.projectChanges }
  }

  return { create, patch, remove, impact }
}
