// server/lib/voice/plan-segments.ts
// Decides how a studio render's text is split before it reaches the rig.
//
// The live agent has no choice but to segment: its text arrives token by token from the LLM,
// so it must start speaking before the sentence is finished. The studio has the whole text
// in hand before the user presses Speak, and was needlessly paying the same tax. Measured,
// one paragraph, same instruction and seed:
//
//     one call          13.92 s audio    29 ms TTFA    6.81 s wall
//     three segments    15.36 s audio     7 ms TTFA    7.53 s wall
//
// Segmenting produced 10.3% MORE audio for the same words — roughly half a second of padding
// at each seam, where prosody restarts because every segment is an independent call with no
// shared state. It bought 22 ms of time-to-first-audio, which is invisible, because Breeze
// streams *within* a call too.
//
// So 'quality' is the studio's default and 'realtime' exists to hear the difference.
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

import { segment } from './segment'

export type SpeakMode = 'quality' | 'realtime'

/** Total prompt characters (instruction + text) that design mode tolerates. 900 text + 80
 *  instruction was healthy and 1000 + 80 ran away, so the observed break sits near 1080;
 *  950 keeps a deliberate margin, because the break was located to ±100 and a different
 *  instruction changes the token mix. */
export const DESIGN_PROMPT_BUDGET = 950

/** Never plan a segment shorter than this, however long the instruction. Below it the text
 *  is chopped so finely that the seams cost more than the ceiling ever would. */
export const MIN_SEGMENT_CHARS = 120

/**
 * The longest single call this preset can take, in characters of TEXT.
 *
 * A reference-backed preset uses its calibrated cap: the clip rides in every prompt and was
 * measured against that exact budget, so it is authoritative and is NOT extended here.
 *
 * A reference-free preset has no calibration (probing one would burn a rig slot to confirm
 * the obvious), so its ceiling is derived from the budget above, minus the instruction it
 * will carry — the two share the prompt.
 */
export function maxCallChars(preset: {
  instruction: string | null
  refStorageKey: string | null
  maxSegmentChars: number
}): number {
  if (preset.refStorageKey) return preset.maxSegmentChars
  const instructionCost = preset.instruction?.trim().length ?? 0
  return Math.max(MIN_SEGMENT_CHARS, DESIGN_PROMPT_BUDGET - instructionCost)
}

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

/** Split on real sentence and clause boundaries, reusing the segmenter the agent uses, then
 *  hard-cap anything still over — `segment` respects boundaries but cannot invent one inside
 *  a single enormous sentence. */
function splitToCap(text: string, cap: number): string[] {
  if (!text) return []
  const { segments, tail } = segment(text, Math.min(cap, Math.floor(cap * 0.7)), cap)
  const all = [...segments, tail].map(s => s.trim()).filter(Boolean)
  const out: string[] = []
  for (const s of all) {
    if (s.length <= cap) { out.push(s); continue }
    for (let i = 0; i < s.length; i += cap) out.push(s.slice(i, i + cap))
  }
  return out
}
