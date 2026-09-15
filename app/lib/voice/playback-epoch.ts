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
// Correctness rests on the frame contract in server/lib/voice/orchestrator.ts: frames are
// ordered and strictly bracketed — `audio-begin`, that segment's PCM, `audio-end`. A stale
// frame can therefore only arrive BEFORE the next segment's `audio-begin`, so re-stamping
// on each begin can never retroactively re-admit one.
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
