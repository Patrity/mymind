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
  const { get, remove, share } = useDocuments()

  // ---- Delete ----
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
      await remove(deleteState.target.id)
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

  // ---- Rename ----
  const renameState = reactive<DialogState>({ open: false, target: null })

  function promptRename(id: string, path: string, label: string) {
    renameState.target = { id, path, label }
    renameState.open = true
  }

  // ---- Move ----
  const moveState = reactive<DialogState>({ open: false, target: null })

  function promptMove(id: string, path: string, label: string) {
    moveState.target = { id, path, label }
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

  // ---- Folder create / rename / move / delete ----
  // STUBS for Task 12 ("Folder create / rename / move / delete in the UI"), which builds
  // FolderDeleteModal and makes RenameModal/MoveModal folder-aware. The folder context menu
  // (Task 10) needs somewhere real to call today rather than nothing, so these give clear
  // toast feedback instead of silently doing nothing. Task 12 replaces the bodies in place —
  // same call sites in Tree.vue, no signature change expected.

  /** STUB — Task 12 wires this to a real create flow against `POST /api/folders`. */
  function promptNewFolder(path: string) {
    toast.add({
      color: 'info',
      title: 'Not built yet',
      description: `Creating a folder under "${path}" ships in a later update.`
    })
  }

  /** STUB — Task 12 wires this to `FolderDeleteModal` (impact counts from `GET /api/folders/[id]/impact`). */
  function promptFolderDelete(folder: DocTreeTarget) {
    toast.add({
      color: 'info',
      title: 'Not built yet',
      description: `Deleting "${folder.label}" ships in a later update.`
    })
  }

  // Folder Rename/Move do NOT reuse promptRename/promptMove. Those submit to the document
  // endpoints (`PUT /api/documents/[id]`, `POST /api/documents/[id]/move`) keyed by a real
  // document id; a folder's tree-item id is its path, so the resulting URL never matches the
  // single-segment `[id]` route and falls through to Nitro's SPA shell, which ofetch treats
  // as a non-throwing 200 — a false "success" toast with zero actual effect. Stub instead
  // (same inert pattern as promptNewFolder/promptFolderDelete) until Task 12 routes these at
  // `PATCH /api/folders/[id]` for real.

  /** STUB — Task 12 wires this to a real folder-aware rename (`PATCH /api/folders/[id]`). */
  function promptFolderRename(folder: DocTreeTarget) {
    toast.add({
      color: 'info',
      title: 'Not built yet',
      description: `Renaming "${folder.label}" ships in a later update.`
    })
  }

  /** STUB — Task 12 wires this to a real folder-aware move (`PATCH /api/folders/[id]`). */
  function promptFolderMove(folder: DocTreeTarget) {
    toast.add({
      color: 'info',
      title: 'Not built yet',
      description: `Moving "${folder.label}" ships in a later update.`
    })
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
    deleteLoading
  }
}
