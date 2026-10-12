// Cycle 84 final fix wave (I5): a per-process cap on judge + guard LLM calls. They share the inference
// server with the pooled workstream segments (cycle 83) but were unpooled: under fan-out (six research
// children, each guarding every fetch) guard calls queued behind each other and hit their 15 s deadline,
// and a fail-closed guard took workspaces offline on routine load. This is a FIFO semaphore: at most
// `judge.maxInFlight` (default 4) calls run at once; the rest wait their turn. A queued call's wait
// counts toward ITS OWN deadline — the caller passes the signal that carries it, and a wait that outlives
// it rejects exactly like a call that timed out (judge: error verdict → review; guard: fail closed on the
// run only, never on the workspace — I5).

export const DEFAULT_JUDGE_MAX_IN_FLIGHT = 4
export const JUDGE_MAX_IN_FLIGHT_LIMITS = { min: 1, max: 16 } as const

let max = DEFAULT_JUDGE_MAX_IN_FLIGHT
let active = 0
const queue: Array<() => void> = []

/** Settings → judge.maxInFlight (agent-settings.ts sets it whenever it reads the settings). An invalid
 *  value reads as the default. Raising it lets queued calls start at once. */
export function setJudgeMaxInFlight(n: unknown): void {
  max = typeof n === 'number' && Number.isInteger(n) && n >= JUDGE_MAX_IN_FLIGHT_LIMITS.min && n <= JUDGE_MAX_IN_FLIGHT_LIMITS.max ? n : DEFAULT_JUDGE_MAX_IN_FLIGHT
  pump()
}

function pump(): void {
  while (active < max && queue.length) {
    active++
    queue.shift()!()
  }
}

/** Wait for a slot (FIFO). Rejects with the signal's reason if it fires first — the waiter leaves the
 *  queue and never takes a slot. */
function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  if (active < max && !queue.length) { active++; return Promise.resolve() }
  return new Promise<void>((resolve, reject) => {
    const grant = () => { signal?.removeEventListener('abort', onAbort); resolve() }
    const onAbort = () => {
      const i = queue.indexOf(grant)
      if (i >= 0) queue.splice(i, 1)
      reject(signal!.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    queue.push(grant)
  })
}

function release(): void {
  active = Math.max(0, active - 1)
  pump()
}

/** Run `fn` holding one judge/guard slot. `signal` bounds the WAIT (and is the caller's deadline). */
export async function withJudgeSlot<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  await acquire(signal)
  try { return await fn() } finally { release() }
}

/** Tests / diagnostics. */
export function judgeSlotStats(): { active: number; queued: number; max: number } {
  return { active, queued: queue.length, max }
}
