import { describe, it, expect } from 'vitest'
import { createPlaybackEpochs } from './playback-epoch'

/**
 * These model the socket handler's exact shape:
 *
 *   binary frame  -> enqueuePcm(data, epochs.segment())     // stamp read at ARRIVAL
 *   audio-begin   -> epochs.beginSegment()
 *   barge-in      -> epochs.interrupt()
 *
 * and enqueuePcm's first line -> if (!epochs.accepts(epoch)) return
 */
function deliverFrame(e: ReturnType<typeof createPlaybackEpochs>): boolean {
  const stamp = e.segment()       // what the call site passes
  return e.accepts(stamp)         // what enqueuePcm checks
}

describe('createPlaybackEpochs', () => {
  it('plays frames of a segment that has not been interrupted', () => {
    const e = createPlaybackEpochs()
    e.beginSegment()
    expect(deliverFrame(e)).toBe(true)
    expect(deliverFrame(e)).toBe(true)
  })

  it('plays the first frames of a session even with no audio-begin ahead of them', () => {
    const e = createPlaybackEpochs()
    expect(deliverFrame(e)).toBe(true)
  })

  it('REGRESSION: drops a frame still in flight when the user barged in', () => {
    // This is the audible tail. Under the old code the socket handler read the LIVE epoch
    // and enqueuePcm compared it to the LIVE epoch, so this frame was always accepted and
    // the guard could not fire at all.
    const e = createPlaybackEpochs()
    e.beginSegment()
    expect(deliverFrame(e)).toBe(true)

    e.interrupt()                 // barge-in: playback stopped, sources killed

    expect(deliverFrame(e)).toBe(false)
    expect(deliverFrame(e)).toBe(false)
  })

  it('plays the replacement turn once its own segment opens', () => {
    const e = createPlaybackEpochs()
    e.beginSegment()
    e.interrupt()
    expect(deliverFrame(e)).toBe(false)

    e.beginSegment()              // the new turn's audio-begin
    expect(deliverFrame(e)).toBe(true)
  })

  it('stays shut across repeated barge-ins until a new segment opens', () => {
    const e = createPlaybackEpochs()
    e.beginSegment()
    e.interrupt()
    e.interrupt()
    e.interrupt()
    expect(deliverFrame(e)).toBe(false)

    e.beginSegment()
    expect(deliverFrame(e)).toBe(true)
  })

  it('a stamp captured before the interrupt is refused when checked after it', () => {
    // The real asynchrony: the stamp travels with the frame, the check happens later.
    const e = createPlaybackEpochs()
    e.beginSegment()
    const stampTakenEarly = e.segment()

    e.interrupt()

    expect(e.accepts(stampTakenEarly)).toBe(false)
  })

  it('does not confuse a later turn with an earlier one that had the same shape', () => {
    const e = createPlaybackEpochs()
    e.beginSegment()
    const first = e.segment()
    e.interrupt()
    e.beginSegment()
    const second = e.segment()

    expect(second).not.toBe(first)
    expect(e.accepts(second)).toBe(true)
    expect(e.accepts(first)).toBe(false)
  })
})
