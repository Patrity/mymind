// @vitest-environment happy-dom
//
// Regression test for the vendored PromptInput provider's submitForm() re-entrancy: a second
// synchronous submitForm() call, while the first is still uploading/awaiting onSubmit, must
// be a no-op — not run onSubmit again, not clear files that belong to the still-in-flight
// first call, and not flip isLoading back to false while the first call is still pending.
// Targets '@/components/ai-elements/prompt-input/context' directly (not AgentPromptInput.vue)
// so it proves the guard lives in the vendored provider itself, independent of any caller.
import type { AttachmentFile, PromptInputContext, PromptInputMessage } from '@/components/ai-elements/prompt-input/types'
import { defineComponent, createApp } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { usePromptInputProvider } from '@/components/ai-elements/prompt-input/context'

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// submitForm's own file-conversion step (Promise.all over async mapper functions) takes a
// few microtask hops even for a non-blob url — a bare `await Promise.resolve()` isn't
// guaranteed to drain all of them. A macrotask boundary (setTimeout) always runs after the
// ENTIRE microtask queue is empty, so this reliably lands after both calls have run their
// synchronous-to-first-real-await prefix (through to `props.onSubmit(...)`, or the guard's
// early return) but before the controlled `d.promise` (which nothing here resolves) settles.
function flushMicrotasks() {
  return new Promise<void>(resolve => setTimeout(resolve, 0))
}

function mountProvider(opts: {
  onSubmit: (message: PromptInputMessage) => void | Promise<void>
  onError?: (err: { code: string, message: string }) => void
}) {
  let ctx!: PromptInputContext
  const app = createApp(defineComponent({
    setup() {
      ctx = usePromptInputProvider(opts)
      return () => null
    }
  }))
  app.mount(document.createElement('div'))
  return { ctx, unmount: () => app.unmount() }
}

function attachment(id: string, name: string): AttachmentFile {
  // A non-blob url so submitForm's blob->dataURL conversion is a pass-through — keeps this
  // test about the re-entrancy guard, not the conversion step.
  return { id, type: 'file', url: `https://example.com/${name}`, mediaType: 'image/png', filename: name, file: new File(['x'], name, { type: 'image/png' }) }
}

describe('PromptInput provider submitForm() re-entrancy', () => {
  it('a second synchronous submitForm() call is a no-op: onSubmit runs once, files clear once on success', async () => {
    const d = deferred<void>()
    const onSubmit = vi.fn(() => d.promise)
    const { ctx } = mountProvider({ onSubmit })

    ctx.setTextInput('hello')
    ctx.files.value = [attachment('a', 'a.png')]

    const p1 = ctx.submitForm()
    const p2 = ctx.submitForm() // races in while call 1 is still awaiting onSubmit
    await flushMicrotasks()

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(ctx.isLoading.value).toBe(true)

    d.resolve()
    await p1
    await p2

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(ctx.files.value).toEqual([])
    expect(ctx.textInput.value).toBe('')
    expect(ctx.isLoading.value).toBe(false)
  })

  it('a race where the in-flight call rejects restores the text AND keeps the files (kept for retry); isLoading stays true until it settles', async () => {
    const d = deferred<void>()
    const onSubmit = vi.fn(() => d.promise)
    const onError = vi.fn()
    const { ctx } = mountProvider({ onSubmit, onError })

    ctx.setTextInput('hello')
    ctx.files.value = [attachment('a', 'a.png')]

    const p1 = ctx.submitForm()
    const p2 = ctx.submitForm()
    await flushMicrotasks()

    // Mid-race, before call 1 settles: the second call must not have torn anything down —
    // this is the exact bug the round-1 fix (a guard inside the CALLER's onSubmit) missed,
    // because the second call's onSubmit resolved (via its own early-return) without
    // throwing, so submitForm treated it as a SUCCESS and ran clearSubmittedFiles/isLoading
    // = false while call 1 was still pending.
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(ctx.files.value).toHaveLength(1)
    expect(ctx.isLoading.value).toBe(true)

    d.reject(new Error('upload failed'))
    await p1
    await p2

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(ctx.textInput.value).toBe('hello') // restored
    expect(ctx.files.value).toHaveLength(1) // kept for retry, not silently dropped
    expect(ctx.isLoading.value).toBe(false)
    expect(onError).toHaveBeenCalledWith({ code: 'submit_error', message: 'upload failed' })
  })
})
