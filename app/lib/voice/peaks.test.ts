// app/lib/voice/peaks.test.ts
import { describe, it, expect } from 'vitest'
import {
  PEAK_WINDOW,
  computePeaks,
  createPeakAccumulator,
  resamplePeaks,
  normalizePeaks,
  formatDuration
} from './peaks'

/** n samples of a constant amplitude — the simplest signal whose envelope is knowable. */
function flat(n: number, amp: number): Float32Array {
  return Float32Array.from({ length: n }, () => amp)
}

describe('computePeaks', () => {
  it('reports the loudest sample in each window, not the average', () => {
    const s = new Float32Array(PEAK_WINDOW * 2)
    s[5] = 0.8 // one transient in an otherwise silent first window
    const peaks = computePeaks(s)
    expect(peaks).toHaveLength(2)
    expect(peaks[0]).toBeCloseTo(0.8)
    expect(peaks[1]).toBe(0)
  })

  it('treats a negative excursion as loud — amplitude is unsigned', () => {
    const s = new Float32Array(PEAK_WINDOW)
    s[0] = -0.9
    expect(computePeaks(s)[0]).toBeCloseTo(0.9)
  })

  it('keeps a trailing partial window so a short clip still draws', () => {
    expect(computePeaks(flat(PEAK_WINDOW + 10, 0.5))).toHaveLength(2)
  })

  it('has no peaks for no samples', () => {
    expect(computePeaks(new Float32Array(0))).toEqual([])
  })
})

describe('createPeakAccumulator', () => {
  // The render arrives as a stream of arbitrarily-sized chunks, so the envelope has to be
  // built incrementally. Chunking must not change the answer, or the waveform would depend
  // on how the network happened to split the body.
  it('produces the same envelope however the samples are chunked', () => {
    const whole = flat(PEAK_WINDOW * 3, 0.4)
    whole[PEAK_WINDOW + 7] = 0.95

    const acc = createPeakAccumulator()
    for (const size of [7, 1, 300, PEAK_WINDOW, 999, 1500]) {
      const taken = acc.total()
      acc.push(whole.subarray(taken, Math.min(whole.length, taken + size)))
    }
    acc.push(whole.subarray(acc.total()))
    acc.flush()

    expect(acc.peaks()).toEqual(computePeaks(whole))
  })

  it('emits nothing until a full window has arrived', () => {
    const acc = createPeakAccumulator()
    acc.push(flat(PEAK_WINDOW - 1, 0.5))
    expect(acc.peaks()).toEqual([])
    acc.push(flat(1, 0.5))
    expect(acc.peaks()).toHaveLength(1)
  })

  it('flush emits the partial tail exactly once', () => {
    const acc = createPeakAccumulator()
    acc.push(flat(10, 0.3))
    acc.flush()
    acc.flush()
    expect(acc.peaks()).toHaveLength(1)
  })
})

describe('resamplePeaks', () => {
  it('fits the envelope to the number of bars the canvas has room for', () => {
    expect(resamplePeaks([1, 2, 3, 4, 5, 6], 3)).toEqual([2, 4, 6])
  })

  // Downsampling by averaging would flatten exactly the transients a waveform exists to show.
  it('keeps the loudest value in each bar rather than averaging it away', () => {
    expect(resamplePeaks([0, 0, 0, 1], 2)).toEqual([0, 1])
  })

  it('stretches a short envelope rather than leaving bars empty', () => {
    expect(resamplePeaks([0.5, 1], 4)).toEqual([0.5, 0.5, 1, 1])
  })

  it('survives an empty envelope', () => {
    expect(resamplePeaks([], 4)).toEqual([0, 0, 0, 0])
  })
})

describe('normalizePeaks', () => {
  it('scales the loudest bar to full height', () => {
    const n = normalizePeaks([0.1, 0.2, 0.3])
    expect(n[0]).toBeCloseTo(1 / 3)
    expect(n[1]).toBeCloseTo(2 / 3)
    expect(n[2]).toBe(1)
  })

  // The waveform's job on the read-aloud pane is partly to show that NOTHING came back.
  // Normalising near-silence to full scale would draw a healthy-looking track for a
  // truncated render — the exact failure the pane is meant to make visible.
  it('leaves near-silence looking silent instead of amplifying it', () => {
    expect(normalizePeaks([0.001, 0.002])).toEqual([0, 0])
  })

  it('survives an empty envelope', () => {
    expect(normalizePeaks([])).toEqual([])
  })
})

describe('formatDuration', () => {
  it('reads a short clip in tenths, the way the reference pane already did', () => {
    expect(formatDuration(11920)).toBe('11.9s')
    expect(formatDuration(900)).toBe('0.9s')
  })

  it('switches to minutes where tenths of a second stop meaning anything', () => {
    expect(formatDuration(60000)).toBe('1:00')
    expect(formatDuration(83400)).toBe('1:23')
    expect(formatDuration(600000)).toBe('10:00')
  })

  it('says nothing rather than something false when there is no duration', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })
})
