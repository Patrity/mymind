// Cycle 85 (spec §3.3, global constraint "pool share"): eval never starves Tony's work. Every turn or
// segment an eval attempt executes first takes a slot here, keyed by the model it runs on; a model's
// eval share is floor(maxInFlight / 2), at least 1. Process-wide, so two suites running at once share
// the same half.
//
// Why a separate cap: an eval world's agent_runs live in its tenant schema, so the per-model pool
// claimNextRun counts (runtime/pools.ts) never sees them beside Tony's rows — without this an eval
// suite could put every model's whole maxInFlight to work while Tony's chat waits on the same model.
import { DEFAULT_MAX_IN_FLIGHT } from '../ai/registry/types'

/** A model's eval share: half its pool (rounded down), never less than one. */
export function evalShareOf(maxInFlight: number | null | undefined): number {
  const n = Number.isFinite(maxInFlight) && (maxInFlight as number) > 0 ? Math.floor(maxInFlight as number) : DEFAULT_MAX_IN_FLIGHT
  return Math.max(1, Math.floor(n / 2))
}

export class EvalSlotAbortedError extends Error {
  constructor() { super('eval: stopped while waiting for a model slot'); this.name = 'EvalSlotAbortedError' }
}

interface Waiter { wake: () => void }

export interface EvalPool {
  /** Take one of `key`'s slots (waits while `cap` are taken). Resolves to its release (idempotent). */
  acquire(key: string, cap: number, signal?: AbortSignal): Promise<() => void>
  /** Slots of `key` in use right now. */
  inUse(key: string): number
}

export function createEvalPool(): EvalPool {
  const used = new Map<string, number>()
  const waiters = new Map<string, Waiter[]>()
  const wakeNext = (key: string) => {
    const q = waiters.get(key)
    const w = q?.shift()
    if (q && !q.length) waiters.delete(key)
    w?.wake()
  }
  return {
    inUse: key => used.get(key) ?? 0,
    acquire: (key, cap, signal) => new Promise<() => void>((resolve, reject) => {
      const take = (): boolean => {
        if ((used.get(key) ?? 0) >= Math.max(1, cap)) return false
        used.set(key, (used.get(key) ?? 0) + 1)
        let released = false
        resolve(() => {
          if (released) return
          released = true
          const n = (used.get(key) ?? 1) - 1
          if (n > 0) used.set(key, n)
          else used.delete(key)
          wakeNext(key)
        })
        return true
      }
      if (signal?.aborted) { reject(new EvalSlotAbortedError()); return }
      if (take()) return
      const w: Waiter = {
        wake: () => {
          signal?.removeEventListener('abort', onAbort)
          if (!take()) { (waiters.get(key) ?? waiters.set(key, []).get(key)!).unshift(w); signal?.addEventListener('abort', onAbort, { once: true }) }
        }
      }
      const onAbort = () => {
        const q = waiters.get(key)
        const i = q?.indexOf(w) ?? -1
        if (q && i >= 0) q.splice(i, 1)
        if (q && !q.length) waiters.delete(key)
        reject(new EvalSlotAbortedError())
      }
      ;(waiters.get(key) ?? waiters.set(key, []).get(key)!).push(w)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

/** The worker's one eval pool. */
export const evalPool: EvalPool = createEvalPool()
