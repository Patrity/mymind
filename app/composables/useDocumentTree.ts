import { useMutation, useQueryClient } from '@tanstack/vue-query'
import type { TreeNode } from '~~/server/services/tree'
import type { DocumentDTO } from '~~/shared/types/documents'
import type { FolderDTO } from '~~/shared/types/folders'
import {
  moveNodeInTree,
  removeNodeFromTree,
  setFolderColorInTree,
  insertDocumentInTree,
  insertFolderInTree
} from '~/lib/documents/tree-mutate'

/** Shared shape for the target of a rename/move/delete dialog. */
export interface DocTreeTarget {
  id: string
  path: string
  label: string
}

interface DialogState {
  open: boolean
  target: DocTreeTarget | null
}

/**
 * Rename and Move are shared between files and folders — one modal component per action,
 * dispatched by `kind` to the right endpoint (`useDocuments()` for files, `useFolders()` for
 * folders). See RenameModal.vue / MoveModal.vue.
 */
interface KindedDialogState extends DialogState {
  kind: 'file' | 'folder'
}

export function basenameOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/**
 * Copy text to the clipboard, falling back to `execCommand` on a non-secure context (plain
 * HTTP, e.g. a LAN dev server) where `navigator.clipboard` doesn't exist. Shared by share-link
 * copy and the "Copy path" menu items so there is exactly one clipboard code path.
 */
export async function copyText(text: string) {
  if (window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* fall through */ }
  }
  // Legacy fallback
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '-9999px'
  document.body.appendChild(ta)
  ta.select()
  ta.setSelectionRange(0, text.length)
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  document.body.removeChild(ta)
  return ok
}

/**
 * Turn a folder-operation error into user-facing copy.
 *
 * `moveFolder` (rename and move both go through it — a rename is a move within the same
 * parent) REFUSES to land on an occupied path rather than merging the two folders together,
 * and reports it as a bare colliding PATH (`folder-http.ts`'s `"Path already taken: <path>"`).
 * On its own that reads as an unexplained rejection with no indication that the fix is "pick a
 * different name" rather than "try again" — this names the actual constraint (no merge) instead
 * of leaving the user to infer it from a path string.
 *
 * Folder-specific: file rename/move keep their existing generic error copy untouched, since
 * they can't hit this collision shape (`documents_path_live_uidx` never reports a bare path).
 */
export function describeFolderError(e: unknown): string {
  const err = e as { status?: number, statusCode?: number, data?: { statusMessage?: string }, message?: string }
  const status = err.status ?? err.statusCode
  const raw = err.data?.statusMessage ?? err.message ?? 'Something went wrong.'
  if (status === 409) {
    const path = raw.replace(/^Path already taken:\s*/, '')
    return `A folder or document already exists at "${path}" — merging folders isn't supported. Choose a different name or destination.`
  }
  return raw
}

// ---------------------------------------------------------------------------
// Optimistic tree mutations (Task 15)
// ---------------------------------------------------------------------------
//
// Rename, move-via-dialog, colour and delete used to end in `emit('refresh')` — a full
// `refetchTree()` round-trip before the UI showed anything. These wrap `useFolders()`/
// `useDocuments()` (kept as thin HTTP fetchers on purpose) in `useMutation`, painting the
// guessed-at tree into the `['document','list']` cache immediately (`onMutate`), rolling back
// to the pre-mutation snapshot on failure (`onError`), and always invalidating afterwards
// (`onSettled`) so the server's real answer — sort order, colour cascade, real ids — wins.
//
// Deliberately NOT used by Tree.vue's drag-and-drop path: Task 13's `childrenByPath`/
// `pendingMoves` machinery already has its own optimistic mechanism for drag moves, reviewed
// hard over two fix rounds. Layering a second cache-writing path onto the SAME move operation
// would race it — exactly the "two sources of truth" bug that machinery exists to prevent. A
// dialog-driven move (context-menu Move, or a drag's cross-project MoveModal hand-off) runs
// AFTER the drag layer has already reverted its own local splice, so there is no overlap.

const TREE_KEY = ['document', 'list'] as const

/**
 * Shared onMutate/onError/onSettled scaffolding for every tree-cache-optimistic mutation below.
 * `applyOptimistic` is a pure function (see `~/lib/documents/tree-mutate.ts`) — this only owns
 * the snapshot/restore/invalidate plumbing, never the tree maths itself.
 */
function useOptimisticTreeMutation<TVars, TResult>(opts: {
  mutationFn: (vars: TVars) => Promise<TResult>
  applyOptimistic: (tree: TreeNode[], vars: TVars) => TreeNode[]
}) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: opts.mutationFn,
    onMutate: async (vars: TVars) => {
      await queryClient.cancelQueries({ queryKey: TREE_KEY })
      const previous = queryClient.getQueryData<TreeNode[]>(TREE_KEY)
      if (previous) {
        queryClient.setQueryData(TREE_KEY, opts.applyOptimistic(previous, vars))
      }
      return { previous }
    },
    onError: (_err, _vars, context) => {
      // A failed mutation must roll back — an optimistic write that survives a rejection is
      // worse than no optimism at all. `previous` is undefined only when the cache was empty
      // to begin with, in which case there is nothing to restore.
      if (context?.previous) {
        queryClient.setQueryData(TREE_KEY, context.previous)
      }
    },
    onSettled: () => {
      // Always — success or failure. A success reconciles the guess with the server's real
      // shape (sort order, colour cascade, real ids); a failure re-confirms the rollback.
      void queryClient.invalidateQueries({ queryKey: TREE_KEY })
    }
  })
}

interface RenameOrMoveVars { id: string, oldPath: string, newPath: string }

/** File rename — `PUT /api/documents/[id]`. Also used for a file's dialog-driven "Move" (a move
 *  is a rename to a path under a different parent; the endpoint and the optimistic shape are
 *  identical either way). */
export function useRenameDocumentMutation() {
  const { update } = useDocuments()
  return useOptimisticTreeMutation<RenameOrMoveVars, DocumentDTO>({
    mutationFn: ({ id, newPath }) => update(id, { path: newPath }),
    applyOptimistic: (tree, { oldPath, newPath }) => moveNodeInTree(tree, oldPath, newPath)
  })
}

/** File move-via-dialog — `POST /api/documents/[id]/move`. Kept distinct from rename above only
 *  because MoveModal and RenameModal call different endpoints; the tree-side effect is the same. */
export function useMoveDocumentMutation() {
  const { move } = useDocuments()
  return useOptimisticTreeMutation<RenameOrMoveVars, DocumentDTO>({
    mutationFn: ({ id, newPath }) => move(id, newPath),
    applyOptimistic: (tree, { oldPath, newPath }) => moveNodeInTree(tree, oldPath, newPath)
  })
}

/** Folder rename AND folder move-via-dialog both go through `PATCH /api/folders/[id]` with a new
 *  `path` — a rename is a move within the same parent (see `describeFolderError`'s note above),
 *  so one mutation covers both call sites (RenameModal and MoveModal, kind: 'folder'). */
export function useMoveFolderMutation() {
  const { patch } = useFolders()
  return useOptimisticTreeMutation<RenameOrMoveVars, { ok: true }>({
    mutationFn: ({ id, newPath }) => patch(id, { path: newPath }),
    applyOptimistic: (tree, { oldPath, newPath }) => moveNodeInTree(tree, oldPath, newPath)
  })
}

/** Folder colour — `PATCH /api/folders/[id]`. */
export function useSetFolderColorMutation() {
  const { patch } = useFolders()
  return useOptimisticTreeMutation<{ id: string, color: string | null }, { ok: true }>({
    mutationFn: ({ id, color }) => patch(id, { color }),
    applyOptimistic: (tree, { id, color }) => setFolderColorInTree(tree, id, color)
  })
}

/** File delete — `DELETE /api/documents/[id]`. */
export function useDeleteDocumentMutation() {
  const { remove } = useDocuments()
  return useOptimisticTreeMutation<{ id: string, path: string }, unknown>({
    mutationFn: ({ id }) => remove(id),
    applyOptimistic: (tree, { path }) => removeNodeFromTree(tree, path)
  })
}

/** Folder delete — `DELETE /api/folders/[id]`. */
export function useDeleteFolderMutation() {
  const { remove } = useFolders()
  return useOptimisticTreeMutation<{ id: string, path: string }, { documents: number, foldersDeleted: number }>({
    mutationFn: ({ id }) => remove(id),
    applyOptimistic: (tree, { path }) => removeNodeFromTree(tree, path)
  })
}

/** Document create — `POST /api/documents`. The optimistic row uses a throwaway temp id; the
 *  real DTO (and its real id) comes back from `mutateAsync`'s resolved value the same as before
 *  this task, so callers that need the real id (opening the new doc in the editor) are unaffected
 *  — only the tree's OWN row appears sooner now. */
export function useCreateDocumentMutation() {
  const { create } = useDocuments()
  return useOptimisticTreeMutation<{ body: Partial<DocumentDTO> & { path: string } }, DocumentDTO>({
    mutationFn: ({ body }) => create(body),
    applyOptimistic: (tree, { body }) => insertDocumentInTree(tree, `temp-${crypto.randomUUID()}`, body.path)
  })
}

/** Folder create — `POST /api/folders`. Same temp-id approach as document create above. */
export function useCreateFolderMutation() {
  const { create } = useFolders()
  return useOptimisticTreeMutation<{ path: string }, FolderDTO>({
    mutationFn: ({ path }) => create(path),
    applyOptimistic: (tree, { path }) => insertFolderInTree(tree, `temp-${crypto.randomUUID()}`, path)
  })
}

/**
 * Rename/move/delete/share/re-triage actions for a document in the tree, plus the
 * open/target state for each confirmation dialog. Extracted from Tree.vue so the dialogs
 * (RenameModal, MoveModal, and the delete confirmation still inline in Tree.vue) and the
 * context-menu wiring share one source of truth for these mutations.
 *
 * `onRefresh` is called after every successful mutation — pass through `() => emit('refresh')`
 * from the caller.
 */
export function useDocumentTree(onRefresh: () => void) {
  const toast = useToast()
  const { get, share } = useDocuments()
  const deleteDocument = useDeleteDocumentMutation()

  // ---- Delete (file) ----
  const deleteState = reactive<DialogState>({ open: false, target: null })
  const deleteLoading = ref(false)

  function promptDelete(id: string, path: string, label: string) {
    deleteState.target = { id, path, label }
    deleteState.open = true
  }

  async function confirmDelete() {
    if (!deleteState.target) return
    deleteLoading.value = true
    try {
      await deleteDocument.mutateAsync({ id: deleteState.target.id, path: deleteState.target.path })
      toast.add({ color: 'success', title: `Deleted "${deleteState.target.label}"` })
      deleteState.open = false
      deleteState.target = null
      onRefresh()
    } catch (e: unknown) {
      const err = e as { data?: { statusMessage?: string }, message?: string }
      toast.add({ color: 'error', title: 'Delete failed', description: err.data?.statusMessage ?? err.message })
    } finally {
      deleteLoading.value = false
    }
  }

  // ---- Rename (file or folder — RenameModal branches on `kind`) ----
  const renameState = reactive<KindedDialogState>({ open: false, target: null, kind: 'file' })

  function promptRename(id: string, path: string, label: string) {
    renameState.target = { id, path, label }
    renameState.kind = 'file'
    renameState.open = true
  }

  function promptFolderRename(folder: DocTreeTarget) {
    renameState.target = folder
    renameState.kind = 'folder'
    renameState.open = true
  }

  // ---- Move (file or folder — MoveModal branches on `kind`) ----
  const moveState = reactive<KindedDialogState>({ open: false, target: null, kind: 'file' })

  function promptMove(id: string, path: string, label: string) {
    moveState.target = { id, path, label }
    moveState.kind = 'file'
    moveState.open = true
  }

  function promptFolderMove(folder: DocTreeTarget) {
    moveState.target = folder
    moveState.kind = 'folder'
    moveState.open = true
  }

  // ---- Share ----
  async function shareDoc(id: string) {
    try {
      // Fetch current state then toggle
      const doc = await get(id)
      const nowPublic = !doc.isPublic
      const updated = await share(id, nowPublic)
      if (nowPublic && updated.publicSlug) {
        const url = `${window.location.origin}/share/${updated.publicSlug}`
        await copyText(url)
        toast.add({ color: 'success', title: 'Document shared', description: 'Public link copied to clipboard' })
      } else {
        toast.add({ color: 'success', title: 'Document is now private' })
      }
      onRefresh()
    } catch (e: unknown) {
      const err = e as { data?: { statusMessage?: string }, message?: string }
      toast.add({ color: 'error', title: 'Share failed', description: err.data?.statusMessage ?? err.message })
    }
  }

  /**
   * Put a document back in the triage sweeper's pool.
   *
   * Only offered for `/input/` files, because that is where a stranded capture sits: triage
   * stamps `documents.triaged_at` on its one automatic pass and deliberately never clears it
   * on a rejection or an undo (auto-clearing would re-propose the same jot every ten minutes,
   * and re-apply it once a confidence bar drops below 1.0). So a capture whose proposal you
   * rejected — or whose applied action you undid — stays in /input forever with no way back.
   * This is the way back.
   */
  async function retriageDoc(id: string, label: string) {
    try {
      await $fetch(`/api/documents/${id}/retriage`, { method: 'POST' })
      toast.add({
        color: 'success',
        title: 'Queued for re-triage',
        description: `“${label}” will be reconsidered on the next sweep (within 10 minutes).`
      })
      onRefresh()
    } catch (e: unknown) {
      const err = e as { data?: { statusMessage?: string }, message?: string }
      toast.add({ color: 'error', title: 'Re-triage failed', description: err.data?.statusMessage ?? err.message })
    }
  }

  // ---- New folder ----
  // Input state (the name being typed) lives in NewFolderModal itself, mirroring
  // NewDocumentModal/RenameModal/MoveModal — this composable only owns open/target-ish state.
  const newFolderState = reactive<{ open: boolean, parentPath: string | null }>({ open: false, parentPath: null })

  function promptNewFolder(path: string) {
    newFolderState.parentPath = path
    newFolderState.open = true
  }

  // ---- Folder delete ----
  // FolderDeleteModal owns its own impact-fetch and delete call (same pattern as
  // Rename/MoveModal owning their submit logic) — this only tracks which folder is targeted.
  const folderDeleteState = reactive<DialogState>({ open: false, target: null })

  function promptFolderDelete(folder: DocTreeTarget) {
    folderDeleteState.target = folder
    folderDeleteState.open = true
  }

  return {
    promptRename,
    promptMove,
    promptDelete,
    confirmDelete,
    shareDoc,
    retriageDoc,
    promptNewFolder,
    promptFolderDelete,
    promptFolderRename,
    promptFolderMove,
    renameState,
    moveState,
    deleteState,
    deleteLoading,
    newFolderState,
    folderDeleteState
  }
}
