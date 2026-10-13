// Token-bucket rate limiter for the Brave Search API (cycle 86). One bucket per process, shared by
// web_search and every research_web fan-out call: callers queue FIFO on acquire().

export const DEFAULT_BRAVE_QPS = 1
export const BRAVE_BURST = 3

export const MAX_QUEUE_WAIT_MS = 60_000

export class SearchBusyError extends Error {
  constructor() { super('search busy, try again') }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('aborted', 'AbortError')
}

/** Resolves with `p`, or rejects as soon as `signal` aborts. */
export function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export interface LimiterClock {
  now(): number
  sleep(ms: number): Promise<void>
}

const realClock: LimiterClock = { now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)) }

export class TokenBucket {
  private tokens: number
  private last: number
  private chain: Promise<void> = Promise.resolve()

  constructor(private rate: number, private readonly burst: number, private readonly clock: LimiterClock = realClock) {
    this.tokens = burst
    this.last = clock.now()
  }

  /** Change the refill rate (tokens/sec) without losing the tokens already accrued. */
  setRate(rate: number): void {
    if (rate === this.rate) return
    this.refill()
    this.rate = rate
  }

  private refill(): void {
    const t = this.clock.now()
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate)
    this.last = t
  }

  /**
   * Resolves when a token is available. Strictly FIFO: concurrent callers queue behind each other.
   * Rejects (and never takes a token) when `signal` aborts, and with SearchBusyError when the token
   * would not arrive within `maxWaitMs` (fails fast: it does not sleep past the deadline).
   */
  acquire(signal?: AbortSignal, maxWaitMs: number = MAX_QUEUE_WAIT_MS): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    const deadline = this.clock.now() + maxWaitMs
    let cancelled: unknown = null
    const run = this.chain.then(async () => {
      for (;;) {
        if (cancelled) throw cancelled
        if (signal?.aborted) throw abortReason(signal)
        this.refill()
        if (this.tokens >= 1) { this.tokens -= 1; return }
        const wait = Math.ceil(((1 - this.tokens) / this.rate) * 1000)
        if (this.clock.now() + wait > deadline) throw new SearchBusyError()
        await raceAbort(this.clock.sleep(wait), signal)
      }
    })
    this.chain = run.then(() => undefined, () => undefined)
    if (!signal) return run
    // Leave the queue immediately on abort (the link then exits on its turn without a token).
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => { cancelled = abortReason(signal); reject(cancelled) }
      signal.addEventListener('abort', onAbort, { once: true })
      run.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }
}

/** The process-wide Brave bucket. */
export const braveLimiter = new TokenBucket(DEFAULT_BRAVE_QPS, BRAVE_BURST)
