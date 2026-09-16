// server/lib/voice/plan-segments.ts
// Decides how a studio render's text is split before it reaches the rig.
//
// Before this, the studio sent EVERY render as one Breeze call whatever its length. That is
// right up to the ceiling and silently wrong past it — see the measurements below. The job
// here is to keep the one-call behaviour wherever it is safe and split only when it is not.
//
// Keeping it matters, because segmenting is not free. Measured, one paragraph, same
// instruction and seed, one call versus three:
//
//     one call          13.92 s audio    29 ms TTFA    6.81 s wall
//     three segments    15.36 s audio     7 ms TTFA    7.53 s wall
//
// Segmenting produced 10.3% MORE audio for the same words — roughly half a second of padding
// at each seam, where prosody restarts because every segment is an independent call with no
// shared state. It bought 22 ms of time-to-first-audio, which is invisible, because Breeze
// streams *within* a call too.
//
// The live agent has no choice: its text arrives token by token from the LLM, so it must
// start speaking before the sentence is finished. The studio always has the whole text.
// So 'quality' is the studio's default and 'realtime' exists to hear the agent's seams.
//
// ── The ceiling is not a style preference; past it the model breaks. ──
// Measured in design mode at cfg 4.0 (the 512-token bucket), one instruction, one seed:
//
//      600 chars ->  19.0 s = 31.6 chars/sec    healthy
//      900 chars ->  21.5 s = 41.9 chars/sec    healthy
//     1000 chars -> 105.6 s =  9.5 chars/sec    RUNAWAY
//     1100 chars -> 120.0 s =  9.2 chars/sec    RUNAWAY (hit the rig's output cap)
//
// It does not truncate — it stops tracking the text and rambles until the cap, returning a
// complete body. The break is between 900 and 1000 characters of TEXT, on top of an 80-char
// instruction, so what actually matters is the combined prompt.

import { maxCallChars, MIN_SEGMENT_CHARS, DESIGN_PROMPT_BUDGET } from '../../../shared/types/voice-presets'

export { maxCallChars, MIN_SEGMENT_CHARS, DESIGN_PROMPT_BUDGET }

export type SpeakMode = 'quality' | 'realtime'

export interface SegmentPlan {
  segments: string[]
  /** Why it was split this way — surfaced in the UI so a seam is explicable rather than a
   *  mystery, and so the user is not left guessing whether Quality mode did anything. */
  reason: 'single-call' | 'exceeds-ceiling' | 'realtime'
  ceiling: number
}

/**
 * Plan a studio render.
 *
 * `quality` sends the text in one call whenever it fits, preserving prosody across the whole
 * passage; it only splits when the text genuinely exceeds what the preset can take, and then
 * splits at the ceiling rather than at the agent's much smaller conversational cap.
 *
 * `realtime` reproduces the agent's segmentation so the two can be compared by ear.
 */
export function planSegments(
  text: string,
  preset: { instruction: string | null; refStorageKey: string | null; maxSegmentChars: number },
  mode: SpeakMode,
  realtimeMaxChars: number
): SegmentPlan {
  const trimmed = text.trim()
  const ceiling = maxCallChars(preset)

  // Guarded before the single-call branch below, which would otherwise return [''] and send
  // an empty segment to the rig for a 400.
  if (!trimmed) return { segments: [], reason: 'single-call', ceiling }

  if (mode === 'realtime') {
    // Cap realtime by the ceiling too: a clone preset calibrated below the conversational
    // cap must not be handed a segment it cannot synthesize just because the mode changed.
    const cap = Math.min(realtimeMaxChars, ceiling)
    return { segments: splitToCap(trimmed, cap), reason: 'realtime', ceiling }
  }

  if (trimmed.length <= ceiling) {
    return { segments: [trimmed], reason: 'single-call', ceiling }
  }
  return { segments: splitToCap(trimmed, ceiling), reason: 'exceeds-ceiling', ceiling }
}

/**
 * Split into as FEW segments as the cap allows, breaking only on sentence boundaries.
 *
 * The agent's `segment()` is deliberately not used for the packing step: it flushes at every
 * real sentence end so the agent can start speaking as early as possible. That is exactly
 * wrong here — it turned 1,480 characters under an 875 ceiling into 20 calls instead of 2,
 * which is 20 rig slots and a seam at every sentence, the opposite of what quality mode is
 * for. (Caught in the browser; the unit test only asserted "more than one segment, each
 * under the cap", which 20 satisfies.)
 *
 * So: greedily pack whole sentences up to the cap, and only hard-slice a single sentence
 * that is itself longer than the cap.
 */
function splitToCap(text: string, cap: number): string[] {
  if (!text) return []
  // Keep the delimiter with its sentence; fall back to the whole text if it has none.
  const sentences = text.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g)?.map(s => s.trim()).filter(Boolean) ?? [text]

  const out: string[] = []
  let current = ''
  const flush = () => { if (current) { out.push(current); current = '' } }

  for (const raw of sentences) {
    if (raw.length > cap) {
      // One sentence longer than the whole budget — nothing to break on but length.
      flush()
      for (let i = 0; i < raw.length; i += cap) out.push(raw.slice(i, i + cap))
      continue
    }
    const candidate = current ? `${current} ${raw}` : raw
    if (candidate.length > cap) { flush(); current = raw } else { current = candidate }
  }
  flush()
  return out
}
