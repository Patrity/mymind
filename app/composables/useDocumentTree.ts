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

async function copyText(text: string) {
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

  return {
    promptRename,
    promptMove,
    promptDelete,
    confirmDelete,
    shareDoc,
    retriageDoc,
    renameState,
    moveState,
    deleteState,
    deleteLoading
  }
}
