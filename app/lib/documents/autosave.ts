// app/lib/documents/autosave.ts
//
// Debounced document autosave, extracted out of app/components/documents/Editor.vue so the
// scheduling rules are unit-testable — the SFC had no test coverage and lost typed text three
// separate ways (see autosave.test.ts).
//
// The load-bearing decision is that the pending edit is stored here as an (id, content) PAIR.
// The SFC used to derive the target from props.documentId at save time, so a save that ran
// after a document switch would have written the outgoing document's text into the incoming
// one. Owning the pair is what makes flush() safe to call from a switch or an unmount.
export type SaveFn = (id: string, content: string) => Promise<void>

export interface Autosave {
  /** Queue `content` to be written to `id` once the debounce delay elapses. */
  schedule(id: string, content: string): void
  /** Write any pending edit now. Resolves once the save settles. Never discards. */
  flush(): Promise<void>
  /** True while an edit is queued but not yet written. */
  hasPending(): boolean
}

export function createAutosave(save: SaveFn, delay = 1500): Autosave {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { id: string, content: string } | null = null

  function take() {
    const edit = pending
    pending = null
    if (timer) { clearTimeout(timer); timer = null }
    return edit
  }

  return {
    schedule(id, content) {
      pending = { id, content }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const edit = take()
        if (edit) void save(edit.id, edit.content)
      }, delay)
    },

    async flush() {
      const edit = take()
      if (edit) await save(edit.id, edit.content)
    },

    hasPending() {
      return pending !== null
    }
  }
}
