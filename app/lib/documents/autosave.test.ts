import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAutosave } from './autosave'

// Extracted out of app/components/documents/Editor.vue, which lost typed text three ways:
// onUnmounted cleared the pending timer without running it, the documentId watcher did the
// same on every document switch, and saveContent() read props.documentId — so even if the
// switch path HAD fired the save, it would have written the outgoing document's text to the
// incoming document. Owning the (id, content) pair is what makes a flush correct here.
describe('createAutosave', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('saves the scheduled edit after the delay', async () => {
    const save = vi.fn(async () => {})
    const a = createAutosave(save, 1500)

    a.schedule('doc-1', 'hello')
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1500)

    expect(save).toHaveBeenCalledExactlyOnceWith('doc-1', 'hello')
  })

  it('debounces rapid edits into one save carrying the latest content', async () => {
    const save = vi.fn(async () => {})
    const a = createAutosave(save, 1500)

    a.schedule('doc-1', 'h')
    await vi.advanceTimersByTimeAsync(500)
    a.schedule('doc-1', 'he')
    await vi.advanceTimersByTimeAsync(500)
    a.schedule('doc-1', 'hel')
    await vi.advanceTimersByTimeAsync(1500)

    expect(save).toHaveBeenCalledExactlyOnceWith('doc-1', 'hel')
  })

  // The unmount bug: navigating away inside the debounce window discarded the edit outright.
  it('flush saves a pending edit immediately instead of discarding it', async () => {
    const save = vi.fn(async () => {})
    const a = createAutosave(save, 1500)

    a.schedule('doc-1', 'typed but not yet autosaved')
    await a.flush()

    expect(save).toHaveBeenCalledExactlyOnceWith('doc-1', 'typed but not yet autosaved')
  })

  // The document-switch bug: the edit belongs to the document it was typed in, not to
  // whichever document happens to be selected by the time the save runs.
  it('flush saves the document the edit belonged to, not one scheduled later', async () => {
    const save = vi.fn(async () => {})
    const a = createAutosave(save, 1500)

    a.schedule('doc-1', 'text for doc 1')
    await a.flush()

    expect(save).toHaveBeenCalledExactlyOnceWith('doc-1', 'text for doc 1')
  })

  it('flush does nothing when there is no pending edit', async () => {
    const save = vi.fn(async () => {})
    const a = createAutosave(save, 1500)

    await a.flush()

    expect(save).not.toHaveBeenCalled()
  })

  // Otherwise the still-armed timer fires after the flush and writes the same body twice —
  // a second revision on every navigation.
  it('flush clears the pending edit so the armed timer cannot save it again', async () => {
    const save = vi.fn(async () => {})
    const a = createAutosave(save, 1500)

    a.schedule('doc-1', 'hello')
    await a.flush()
    await vi.advanceTimersByTimeAsync(3000)

    expect(save).toHaveBeenCalledOnce()
  })

  it('reports whether an edit is waiting to be written', async () => {
    const save = vi.fn(async () => {})
    const a = createAutosave(save, 1500)

    expect(a.hasPending()).toBe(false)
    a.schedule('doc-1', 'hello')
    expect(a.hasPending()).toBe(true)
    await vi.advanceTimersByTimeAsync(1500)
    expect(a.hasPending()).toBe(false)
  })
})
