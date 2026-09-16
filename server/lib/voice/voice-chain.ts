// server/lib/voice/voice-chain.ts
// Keeps one speaker for a whole spoken turn.
//
// THE PROBLEM. Breeze carries no speaker state between calls. A seed reproduces an
// identical input exactly — same seed, same text, twice, measured 263.7 Hz both times — but
// it does NOT pin identity across DIFFERENT text. The agent sends one call per segment, so
// every segment casts a fresh person. Measured, one reference-free preset, one seed, four
// segments of a single reply:
//
//     200.0 Hz  244.9 Hz  102.6 Hz  148.1 Hz     spread 142 Hz
//
// 102.6 Hz is a man and 244.9 Hz is a woman, inside one answer. That is not drift, it is
// recasting, and no preset setting prevents it.
//
// THE FIX. A reference clip DOES anchor identity (an external one measured a 14.7 Hz spread
// across the same four segments). We do not need the user to supply one: the first segment
// of a turn IS a recording of the voice we want, and we already know its exact text, so it
// can serve as the reference for every later segment of that turn. No transcription, no
// extra round trip, and segment 1 still goes out the instant the first words arrive — the
// streaming behaviour is untouched.
//
//     chained, keeping the instruction (direction mode, cfg 4):
//     200.0 Hz  214.3 Hz  201.7 Hz  195.1 Hz     spread 19.2 Hz
//
// Keeping the instruction matters: chaining as a PLAIN clone (cfg 1, instruction dropped)
// measured a 38.9 Hz spread, twice as loose. The description and the clip anchor the same
// voice from two directions, so both are kept.
//
// Chaining is skipped for a preset that already HAS its own reference — that clip is a
// deliberate choice and anchors better than a synthetic first segment (14.7 vs 19.2 Hz).

import { pcmToWav } from './speak'
import type { VoicePresetDTO } from '../../../shared/types/voice-presets'

/** A reference clip needs enough voiced speech to characterise a speaker. Below this the
 *  first segment is too short to anchor anything, so the turn simply stays unchained. */
export const MIN_CHAIN_REFERENCE_MS = 1500

/** Never build a reference out of more than this. The clip shares the prompt budget with
 *  the text, and past a few seconds it buys no extra likeness — only budget. */
export const MAX_CHAIN_REFERENCE_MS = 10_000

export interface ChainReference {
  /** A complete WAV of (the first part of) segment one. */
  audio: Uint8Array
  /** Segment one's text, verbatim. Breeze requires the transcript to match the audio, and
   *  because we synthesized it we know it exactly — there is nothing to transcribe. */
  text: string
}

export interface VoiceChain {
  /** Feed a segment's audio as it streams. Only the first segment is retained. */
  capture(text: string, bytes: Uint8Array): void
  /** Close off the current segment. After the first one completes, a reference exists. */
  endSegment(): void
  /** The anchor for segments after the first, or null while none is available. */
  reference(): ChainReference | null
}

/**
 * Build a chain for one turn.
 *
 * `enabled` is false when the preset brings its own reference — see the header. A disabled
 * chain captures nothing and always reports no reference, so callers need no special case.
 */
export function createVoiceChain(sampleRate: number, enabled = true): VoiceChain {
  const maxBytes = Math.floor((MAX_CHAIN_REFERENCE_MS / 1000) * sampleRate) * 2
  const minBytes = Math.floor((MIN_CHAIN_REFERENCE_MS / 1000) * sampleRate) * 2

  let parts: Uint8Array[] = []
  let bytes = 0
  let firstText = ''
  let ready: ChainReference | null = null
  let segmentsSeen = 0

  return {
    capture(text, chunk) {
      if (!enabled || ready || segmentsSeen > 0) return
      firstText = text
      if (bytes >= maxBytes) return
      parts.push(chunk)
      bytes += chunk.length
    },
    endSegment() {
      if (!enabled) return
      segmentsSeen++
      if (ready || segmentsSeen !== 1) return
      // A segment that produced too little audio (a dropped or truncated render) cannot
      // anchor anything. Leaving the chain unbuilt is right: an unanchored turn is worse
      // than a chained one, but a turn anchored to half a syllable is worse than both.
      if (bytes < minBytes || !firstText.trim()) { parts = []; bytes = 0; return }
      const pcm = new Uint8Array(bytes)
      let at = 0
      for (const p of parts) { pcm.set(p, at); at += p.length }
      ready = { audio: new Uint8Array(pcmToWav(pcm.subarray(0, maxBytes), sampleRate)), text: firstText }
      parts = []   // the WAV is built; the pieces are dead weight for the rest of the turn
    },
    reference() {
      return ready
    },
  }
}

/**
 * The preset a chained segment should be spoken with.
 *
 * Returns a DIRECTION preset: the original instruction and cfg are kept, and the chain's
 * transcript is attached. `refStorageKey` is set to a sentinel because it is what marks a
 * preset as reference-backed downstream (mode derivation, the segment ceiling); the bytes
 * themselves travel separately, since they live only in memory for this turn.
 */
export function chainedPreset(preset: VoicePresetDTO, ref: ChainReference): VoicePresetDTO {
  return { ...preset, refStorageKey: CHAIN_REF_KEY, refText: ref.text }
}

/** Marks a preset as anchored to a turn-local chain rather than a stored clip. Never a real
 *  storage key, and never written to the database. */
export const CHAIN_REF_KEY = '__chain__'

/** True when a preset should build a chain: it has no reference of its own to anchor to. */
export function shouldChain(preset: VoicePresetDTO): boolean {
  return !preset.refStorageKey
}
