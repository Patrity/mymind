// app/lib/documents/autosave.ts
//
// Debounced document autosave, extracted out of app/components/documents/Editor.vue so the
// scheduling rules are unit-testable — the SFC had no test coverage and lost typed text three
// separate ways (see autosave.test.ts).
//
// The load-bearing decision is that the pending edit is stored here as an (id, payload) PAIR.
// The SFC used to derive the target from props.documentId at save time, so a save that ran
// after a document switch would have written the outgoing document's text into the incoming
// one. Owning the pair is what makes flush() safe to call from a switch or an unmount.
//
// Generic over the payload `T`: Inspector.vue's metadata save (title/project/domain/type/tags,
// not a content string) reuses this same module instead of hand-rolling its own copy of the
// identical (timer + default-parameter id) mechanism — see autosave.test.ts's "non-string
// payload" tests for the document-switch corruption bug that hand-rolled copy had (a pending
// metaSaveTimer surviving a switch fired after props.documentId had already moved on, writing
// the OUTGOING document's metadata onto the INCOMING one).
export type SaveFn<T> = (id: string, payload: T) => Promise<void>

export interface Autosave<T> {
  /** Queue `payload` to be written to `id` once the debounce delay elapses. */
  schedule(id: string, payload: T): void
  /** Write any pending edit now. Resolves once the save settles. Never discards. */
  flush(): Promise<void>
  /** True while an edit is queued but not yet written. */
  hasPending(): boolean
}

export function createAutosave<T>(save: SaveFn<T>, delay = 1500): Autosave<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { id: string, payload: T } | null = null

  function take() {
    const edit = pending
    pending = null
    if (timer) { clearTimeout(timer); timer = null }
    return edit
  }

  return {
    schedule(id, payload) {
      pending = { id, payload }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const edit = take()
        if (edit) void save(edit.id, edit.payload)
      }, delay)
    },

    async flush() {
      const edit = take()
      if (edit) await save(edit.id, edit.payload)
    },

    hasPending() {
      return pending !== null
    }
  }
}
