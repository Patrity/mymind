// Which PCM frames still belong to the turn the user is actually listening to.
//
// Extracted from useVoice so the rule can be tested. It was NOT testable while it lived
// inline, and the cost of that was a guard that read as protection and provided none for a
// whole cycle: the socket handler passed the LIVE epoch into a check against the live
// epoch, in the same synchronous tick, so the two could never differ.
//
// The race being defended against:
//
//   1. a segment opens (`audio-begin`) and its PCM frames start arriving;
//   2. the user barges in — playback stops, already-scheduled sources are killed;
//   3. a frame that was ALREADY on the wire when (2) happened arrives anyway.
//
// Step 3 is the audible tail. Stopping the scheduled sources cannot reach it, because it
// had not been scheduled yet. It has to be refused on arrival, and the only thing that
// distinguishes it is which turn it was born in.
//
// What this DOES guarantee, and what it does not.
//
// The frame contract in server/lib/voice/orchestrator.ts is ordered and strictly bracketed —
// `audio-begin`, that segment's PCM, `audio-end`. So every remaining frame of the segment
// that was OPEN when the user interrupted carries the pre-interrupt stamp and is refused.
// That is the tail, and that is what this fixes.
//
// It is NOT airtight, and the honest boundary matters more than the tidy claim. `beginSegment()`
// re-opens the gate unconditionally, because the client cannot tell which turn an `audio-begin`
// belongs to — no frame carries a turn id. The interrupt travels client->server as
// `{type:'interrupt'}` and takes one RTT to land; if the server opens the NEXT segment of the
// SAME (interrupted) turn inside that window, its `audio-begin` re-stamps at the current epoch
// and that turn's audio is admitted again.
//
// In practice the window is narrow: the pipeline is serial (concurrency 1), a segment costs
// hundreds of milliseconds to synthesize, and ws.ts aborts the turn on the interrupt frame. It
// is strictly better than the dead guard it replaces. But it is a window, not zero, and closing
// it properly needs a turn id on the wire so the client can refuse a begin from a turn it has
// already walked away from — a protocol change, not a client-side one.
//
// Do not restate this as "can never re-admit a stale frame". A comment claiming more protection
// than exists is how the original dead guard survived three reviews.
export interface PlaybackEpochs {
  /** Invalidate everything from the turn in progress. Called on barge-in and on stop. */
  interrupt: () => void
  /** Stamp a newly-opened segment with the current turn. Called on `audio-begin`. */
  beginSegment: () => void
  /** The stamp to attach to frames arriving now — pass this to `accepts` later. */
  segment: () => number
  /** Does a frame carrying this stamp still belong to the turn being listened to? */
  accepts: (epoch: number) => boolean
}

export function createPlaybackEpochs(): PlaybackEpochs {
  let playEpoch = 0
  // Starts equal to playEpoch so the first segment of a session plays even if it somehow
  // arrives without an `audio-begin` ahead of it.
  let segmentEpoch = 0
  return {
    interrupt() { playEpoch++ },
    beginSegment() { segmentEpoch = playEpoch },
    segment() { return segmentEpoch },
    accepts(epoch: number) { return epoch === playEpoch }
  }
}
