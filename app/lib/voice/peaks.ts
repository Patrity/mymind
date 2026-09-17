// app/lib/voice/peaks.ts
// The amplitude envelope behind the studio's waveform tracks — "sound levels over time".
//
// Pure and synchronous on purpose. The render arrives as a stream of arbitrarily-sized
// chunks, so the envelope has to be built incrementally, and "incrementally" is exactly the
// kind of code that quietly depends on how the network split the body. Keeping it here, away
// from the AudioContext, is what lets that property be asserted.

/** Samples per envelope point. At 24 kHz this is ~43 ms — fine enough to show a syllable,
 *  coarse enough that a two-minute render is ~2800 numbers rather than three million. */
export const PEAK_WINDOW = 1024

/** Below this the signal is indistinguishable from a dead stream, and normalising it to full
 *  scale would draw a healthy waveform for a render that produced nothing. */
const SILENCE_FLOOR = 0.005

/**
 * Max ABSOLUTE amplitude per window. Max rather than mean: a waveform exists to show
 * transients, and averaging is precisely what removes them.
 */
export function computePeaks(samples: Float32Array, window = PEAK_WINDOW): number[] {
  const peaks: number[] = []
  for (let i = 0; i < samples.length; i += window) {
    let max = 0
    const end = Math.min(i + window, samples.length)
    for (let j = i; j < end; j++) {
      const v = Math.abs(samples[j] ?? 0)
      if (v > max) max = v
    }
    peaks.push(max)
  }
  return peaks
}

export interface PeakAccumulator {
  /** Add the next chunk of decoded samples. Emits a peak per COMPLETE window only. */
  push: (samples: Float32Array) => void
  /** Emit the partial trailing window, so a clip shorter than one window still draws.
   *  Idempotent — calling it twice does not append a second tail. */
  flush: () => void
  peaks: () => number[]
  /** Samples consumed so far. Lets a caller resume mid-stream without tracking it twice. */
  total: () => number
}

/** Builds the envelope across streamed chunks. The result is identical to running
 *  `computePeaks` over the whole buffer, whatever the chunk boundaries were. */
export function createPeakAccumulator(window = PEAK_WINDOW): PeakAccumulator {
  const peaks: number[] = []
  let max = 0
  let filled = 0
  let total = 0

  return {
    push(samples: Float32Array) {
      total += samples.length
      for (let i = 0; i < samples.length; i++) {
        const v = Math.abs(samples[i] ?? 0)
        if (v > max) max = v
        if (++filled === window) {
          peaks.push(max)
          max = 0
          filled = 0
        }
      }
    },
    flush() {
      if (filled === 0) return
      peaks.push(max)
      max = 0
      filled = 0
    },
    peaks: () => peaks,
    total: () => total
  }
}

/**
 * Fit an envelope to exactly `buckets` bars — however many the canvas has room for.
 *
 * Reduces by MAX for the same reason computePeaks does. Stretches when the envelope is
 * shorter than the bar count, so a very short clip fills the track instead of drawing a few
 * bars against empty space.
 */
export function resamplePeaks(peaks: number[], buckets: number): number[] {
  if (buckets <= 0) return []
  if (!peaks.length) return new Array(buckets).fill(0)
  const out: number[] = []
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * peaks.length) / buckets)
    const to = Math.max(from + 1, Math.floor(((b + 1) * peaks.length) / buckets))
    let max = 0
    for (let i = from; i < to && i < peaks.length; i++) {
      const v = peaks[i] ?? 0
      if (v > max) max = v
    }
    out.push(max)
  }
  return out
}

/** Scale so the loudest bar fills the track. Speech rarely approaches full scale, and drawn
 *  raw it reads as a flat line — but near-silence stays near-silent, because a truncated
 *  render looking healthy is the one mistake this display must not make. */
export function normalizePeaks(peaks: number[]): number[] {
  if (!peaks.length) return []
  const max = peaks.reduce((m, v) => (v > m ? v : m), 0)
  if (max < SILENCE_FLOOR) return peaks.map(() => 0)
  return peaks.map(v => v / max)
}

/** `11.9s` while tenths still mean something, `1:23` once they do not, `—` for no duration. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
