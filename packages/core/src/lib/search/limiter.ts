// Token-bucket rate limiter for the Brave Search API (cycle 86). One bucket per process, shared by
// web_search and every research_web fan-out call: callers queue FIFO on acquire().

export const DEFAULT_BRAVE_QPS = 1
export const BRAVE_BURST = 3

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

  /** Resolves when a token is available. Strictly FIFO: concurrent callers queue behind each other. */
  acquire(): Promise<void> {
    const run = this.chain.then(async () => {
      for (;;) {
        this.refill()
        if (this.tokens >= 1) { this.tokens -= 1; return }
        await this.clock.sleep(Math.ceil(((1 - this.tokens) / this.rate) * 1000))
      }
    })
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }
}

/** The process-wide Brave bucket. */
export const braveLimiter = new TokenBucket(DEFAULT_BRAVE_QPS, BRAVE_BURST)
