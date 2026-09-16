// app/lib/voice/audio-context.ts
// Why this exists: a browser only lets a page start audio from inside a user gesture, and
// the gesture's "activation" is consumed by the first `await`. Create an AudioContext after
// awaiting a fetch and Chrome hands back one in `suspended` state — it never starts, every
// buffer scheduled on it is silent, and NOTHING is logged. That was the studio's
// intermittent-playback bug: it worked only when the origin had accumulated enough sticky
// activation to be exempt from the autoplay policy, which is why it looked random.
//
// So the rule this module enforces is: the context is created and resumed BEFORE any await,
// and it is never closed between renders (closing it means the next render has to build one
// outside a gesture, reintroducing the same bug).
//
// Pure and injectable so the ordering can actually be tested — see audio-context.test.ts,
// which asserts the context exists and is running before a request is issued.

export type AudioContextFactory = (opts: { sampleRate: number }) => AudioContext

export interface AudioGate {
  /** Create-or-reuse the context and resume it if suspended. MUST be called synchronously
   *  from the user-gesture handler, before anything is awaited. Returns null when the
   *  environment has no AudioContext (SSR, or a test without one stubbed). */
  ensure(sampleRate: number): AudioContext | null
  /** The live context, or null if `ensure` has not run. */
  current(): AudioContext | null
  /** Resume if the browser suspended it. Safe to await after `ensure` — the activation was
   *  already spent by `ensure`, this only settles the promise. */
  resume(): Promise<void>
  /** Drop the context entirely. For unmount only — NOT between renders. */
  release(): void
}

export function createAudioGate(factory?: AudioContextFactory): AudioGate {
  let ctx: AudioContext | null = null
  let rate = 0

  const make: AudioContextFactory | null = factory
    ?? (typeof AudioContext !== 'undefined' ? (o => new AudioContext(o)) : null)

  return {
    ensure(sampleRate: number) {
      if (!make) return null
      // A context is locked to its sample rate at construction. The rig is 24 kHz and says
      // so on /health, so we build at the expected rate up front rather than waiting for
      // the response header — waiting is precisely what cost us the gesture. On the rare
      // mismatch we rebuild, which is safe because by then the origin has activation.
      if (ctx && ctx.state !== 'closed' && rate === sampleRate) {
        if (ctx.state === 'suspended') void ctx.resume()
        return ctx
      }
      if (ctx && ctx.state !== 'closed') void ctx.close()
      ctx = make({ sampleRate })
      rate = sampleRate
      // Fire-and-forget here so `ensure` stays synchronous: awaiting inside the gesture
      // handler is what we are avoiding. `resume()` below is the awaitable form.
      if (ctx.state === 'suspended') void ctx.resume()
      return ctx
    },
    current() {
      return ctx && ctx.state !== 'closed' ? ctx : null
    },
    async resume() {
      if (ctx && ctx.state === 'suspended') await ctx.resume()
    },
    release() {
      if (ctx && ctx.state !== 'closed') void ctx.close()
      ctx = null
      rate = 0
    },
  }
}

// Detecting a RUNAWAY generation — the failure the byte count provably cannot see.
//
// Past roughly a thousand characters the model stops tracking the text and rambles until
// the rig's 120 s output cap, and that arrives as a COMPLETE, healthy-looking body. Measured
// on the rig, one instruction and one seed held constant across the sweep:
//
//     600 chars ->  19.0 s = 31.6 chars/sec    healthy
//     900 chars ->  21.5 s = 41.9 chars/sec    healthy
//    1200 chars -> 109.4 s = 11.0 chars/sec    runaway
//    1500 chars -> 120.0 s = 12.5 chars/sec    runaway (hit the cap)
//
// Chars-per-second separates those cleanly. A *ratio against an expected duration* does not:
// 1200 chars lands at 2.9x expected and 1500 at 2.6x, while short healthy renders reach 2.0x,
// so no ratio threshold divides them. The first version of this function used a ratio and had
// to be rewritten against the numbers.

/** Below this, a render is producing far less speech than its text should yield. Sits between
 *  the measured healthy floor (31.6) and the runaway ceiling (12.5), with margin either side. */
export const MIN_CHARS_PER_SECOND = 20

/** Short renders are not judged: lead-in and lead-out are a fixed cost, so they dominate the
 *  rate below a few hundred characters (an 88-char line measured 15.7 chars/sec while being
 *  perfectly healthy). Nothing is lost — runaway only occurs on long text in the first place. */
export const RUNAWAY_MIN_CHARS = 400

/** True when a finished render produced far more audio than its text can account for. */
export function isRunawayRender(chars: number, audioSeconds: number): boolean {
  if (chars < RUNAWAY_MIN_CHARS || audioSeconds <= 0) return false
  return chars / audioSeconds < MIN_CHARS_PER_SECOND
}
