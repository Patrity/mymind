// Breeze serves ONE inference at a time and returns 409 to anything else. Since MyMind
// is a single Nitro process, one in-process queue is the entire concurrency story — a
// 409 escaping to a caller means something OUTSIDE MyMind took the slot (the interim
// Gradio studio on the rig), not that this queue failed.
//
// Two priorities, and they only ever reorder WAITERS. There is no preemption: once a
// studio render holds the slot, a live turn arriving behind it waits for that render to
// finish in full. Priority buys a live turn the front of the queue, not the slot.

export type QueuePriority = 'agent' | 'studio'

interface Waiter {
  priority: QueuePriority
  resolve: (release: () => void) => void
  reject: (err: Error) => void
  cleanup: () => void
}

export interface BreezeQueue {
  /** Resolves with a release function once the slot is yours. Call release EXACTLY once,
   *  in a finally, after the audio stream is fully drained or has errored. */
  acquire(priority: QueuePriority, signal?: AbortSignal): Promise<() => void>
  /** Number of waiters not yet granted the slot. */
  readonly depth: number
}

export function createBreezeQueue(): BreezeQueue {
  let held = false
  const waiters: Waiter[] = []

  function grantNext(): void {
    if (held) return
    // Agent first, then FIFO within priority. findIndex preserves insertion order
    // among equals, which is what keeps same-priority calls in arrival order.
    let idx = waiters.findIndex(w => w.priority === 'agent')
    if (idx === -1) idx = waiters.length ? 0 : -1
    if (idx === -1) return
    const [w] = waiters.splice(idx, 1)
    if (!w) return
    w.cleanup()
    held = true
    w.resolve(makeRelease())
  }

  function makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return        // double-release must not hand the slot out twice
      released = true
      held = false
      grantNext()
    }
  }

  return {
    acquire(priority, signal) {
      if (signal?.aborted) return Promise.reject(new Error('aborted before acquiring TTS slot'))
      return new Promise<() => void>((resolve, reject) => {
        if (!held && waiters.length === 0) {
          held = true
          resolve(makeRelease())
          return
        }
        const onAbort = () => {
          const i = waiters.indexOf(waiter)
          if (i !== -1) waiters.splice(i, 1)
          reject(new Error('aborted while waiting for TTS slot'))
        }
        const waiter: Waiter = {
          priority,
          resolve,
          reject,
          cleanup: () => signal?.removeEventListener('abort', onAbort)
        }
        waiters.push(waiter)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    get depth() { return waiters.length }
  }
}

export const breezeQueue: BreezeQueue = createBreezeQueue()
