// app/lib/voice/studio.ts
// Pure logic for the /voice studio. Everything here is a decision the panes make about
// what the user is ALLOWED to compose and what a result MEANS — kept out of the .vue
// files so it can be tested without mounting anything (same precedent as devices.ts,
// messages.ts and presets.ts in this directory).
import type { VoicePresetDTO, SpeakOverrides } from '~~/shared/types/voice-presets'
import { presetMode } from '~~/shared/types/voice-presets'

/** The editable shape of a preset while it is being designed. Mirrors PresetInput on the
 *  server, except that the two nullable text fields are plain strings here — a textarea
 *  binds to '' , not to null, and the conversion happens once on the way out. */
export interface PresetDraft {
  name: string
  instruction: string
  cfgScale: number
  seed: number
  temperature: number
  topP: number
  topK: number
  refStorageKey: string | null
  refText: string
  refDurationMs: number | null
}

/** What POST/PATCH /api/voice/presets accepts. */
export interface PresetBody {
  name: string
  instruction: string | null
  cfgScale: number
  seed: number
  temperature: number
  topP: number
  topK: number
  refStorageKey: string | null
  refText: string | null
  refDurationMs: number | null
}

// ── Guidance (cfg_scale) ──────────────────────────────────────────────────────
//
// `cfg_scale > 1` without an instruction is a DB CHECK violation
// (voice_presets_cfg_needs_instruction) AND an opaque 500 at the rig, because Breeze has
// no negative prompt to push against. The UI locks the slider at 1.0 rather than letting
// the combination be composed at all: a preset that cannot be saved should never be
// reachable in the first place, and a 500 from the rig carries no message to explain it.

export const CFG_MIN = 1
export const CFG_MAX = 8
export const CFG_LOCK_REASON
  = 'Guidance needs an instruction to push against — write one above to raise it past 1.0.'

export function isCfgLocked(instruction: string | null | undefined): boolean {
  return !instruction?.trim()
}

/** The largest cfgScale this draft may legally carry. */
export function clampCfgScale(cfgScale: number, instruction: string | null | undefined): number {
  const bounded = Math.min(Math.max(cfgScale, CFG_MIN), CFG_MAX)
  return isCfgLocked(instruction) ? CFG_MIN : bounded
}

// ── Draft validation ──────────────────────────────────────────────────────────

/**
 * Every reason this draft would be rejected, in the order the form shows them. These
 * mirror the table's CHECK constraints one-for-one — the point is that the Save button
 * is dark BEFORE the request, not that the error is prettier afterwards.
 */
export function validatePresetDraft(d: PresetDraft): string[] {
  const errors: string[] = []
  if (!d.name.trim()) errors.push('Name is required.')
  if (!(d.cfgScale > 0)) errors.push('Guidance must be greater than 0.')
  if (d.cfgScale > 1 && isCfgLocked(d.instruction)) errors.push(CFG_LOCK_REASON)
  // A reference without its transcript is the same class of guaranteed-500 as cfg
  // without an instruction: Breeze needs the text to match the clip exactly.
  if (d.refStorageKey && !d.refText.trim()) {
    errors.push('A reference clip needs its transcript — it must match the audio exactly.')
  }
  return errors
}

/** Draft → request body. Blank text becomes null so the CHECKs see NULL, not ''. */
export function draftToBody(d: PresetDraft): PresetBody {
  return {
    name: d.name.trim(),
    instruction: d.instruction.trim() || null,
    cfgScale: clampCfgScale(d.cfgScale, d.instruction),
    seed: d.seed,
    temperature: d.temperature,
    topP: d.topP,
    topK: d.topK,
    refStorageKey: d.refStorageKey,
    refText: d.refText.trim() || null,
    refDurationMs: d.refDurationMs
  }
}

/** An unsaved, legal starting point: no instruction, so guidance must sit at 1. */
export function blankDraft(): PresetDraft {
  return {
    name: '',
    instruction: '',
    cfgScale: 1,
    seed: 11,
    temperature: 0.9,
    topP: 1,
    topK: 50,
    refStorageKey: null,
    refText: '',
    refDurationMs: null
  }
}

/** Preset → draft, for loading the selected row into the form. */
export function presetToDraft(p: VoicePresetDTO): PresetDraft {
  return {
    name: p.name,
    instruction: p.instruction ?? '',
    cfgScale: p.cfgScale,
    seed: p.seed,
    temperature: p.temperature,
    topP: p.topP,
    topK: p.topK,
    refStorageKey: p.refStorageKey,
    refText: p.refText ?? '',
    refDurationMs: p.refDurationMs
  }
}

/** True when the form differs from the row it was loaded from. Drives the Save button —
 *  and nothing else. It used to gate the audition too, back when auditioning PATCHed the
 *  row; overrides removed that, so an audition now previews unsaved edits. */
export function draftIsDirty(d: PresetDraft, p: VoicePresetDTO | null): boolean {
  if (!p) return true
  const a = draftToBody(d)
  const b = draftToBody(presetToDraft(p))
  return (Object.keys(b) as (keyof PresetBody)[]).some(k => a[k] !== b[k])
}

/**
 * A name no existing preset already holds. `voice_presets_name_key` is a UNIQUE index, so
 * "Duplicate" on a list that already contains "warm (copy)" would otherwise come back as
 * an unexplained 500 — the one action where a collision is the expected case.
 */
export function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`
    if (!used.has(candidate)) return candidate
  }
  return `${base} ${Date.now()}`
}

// ── Mode, for display ─────────────────────────────────────────────────────────

/** Badge colours are semantic tokens, resolved here so the rail and the design pane
 *  cannot disagree about what a mode looks like. */
export type BadgeColor = 'neutral' | 'primary' | 'info' | 'success'

export interface ModeBadge { label: string, color: BadgeColor, hint: string }

const MODE_BADGES: Record<ReturnType<typeof presetMode>, ModeBadge> = {
  plain: { label: 'plain', color: 'neutral', hint: 'No instruction, no reference — Breeze picks the voice.' },
  design: { label: 'design', color: 'primary', hint: 'Voice designed from the written instruction.' },
  clone: { label: 'clone', color: 'info', hint: 'Cloned from the reference clip.' },
  direction: { label: 'direction', color: 'success', hint: 'Cloned from the reference clip, then directed by the instruction.' }
}

export function modeBadge(p: Pick<VoicePresetDTO, 'instruction' | 'refStorageKey'>): ModeBadge {
  return MODE_BADGES[presetMode(p)]
}

// ── Seeds ─────────────────────────────────────────────────────────────────────

/** The dice button. `rng` is injectable so the range can be asserted. */
export function randomSeed(rng: () => number = Math.random): number {
  return Math.floor(rng() * 999999) + 1
}

/** The four seeds an audition renders. Distinct by construction — auditioning the same
 *  voice twice wastes a rig slot, and the rig serves ONE request at a time. */
export function auditionSeeds(current: number, rng: () => number = Math.random): number[] {
  const seeds = [current]
  let guard = 0
  while (seeds.length < 4 && guard++ < 100) {
    const next = randomSeed(rng)
    if (!seeds.includes(next)) seeds.push(next)
  }
  // Degenerate rng (a stub that always returns the same number) must still yield four
  // DISTINCT slots rather than hanging or returning a short list the UI would mis-render.
  let filler = 1
  while (seeds.length < 4) {
    while (seeds.includes(filler)) filler++
    seeds.push(filler)
  }
  return seeds
}

// ── Auditioning ───────────────────────────────────────────────────────────────
//
// An audition is a PREVIEW. It renders the same sentence at four seeds — and, because the
// same mechanism carries every tunable parameter, at whatever the user has currently got
// on screen rather than at whatever was last saved.
//
// It sends those parameters as `overrides` on POST /api/voice/speak, which merges them in
// memory for one request. It must NEVER write: the earlier shape PATCHed the row's seed
// per take and put it back in a `finally`, so a closed tab or a dropped connection left
// the preset stuck on an audition seed — and the live agent resolves that same row on
// every turn, so it would then have spoken in it.

/** The body POST /api/voice/speak accepts. */
export interface SpeakRequestBody {
  text: string
  presetId: string
  /** Omitted for the streaming path; 'wav' returns a complete file. */
  format?: 'wav'
  overrides?: SpeakOverrides
}

/**
 * The draft's tunable parameters, as overrides. Deliberately carries neither the name nor
 * anything about the reference clip nor the calibrated ceiling — those are properties of
 * the SAVED voice, and the server's allow-list refuses them anyway.
 *
 * cfgScale goes through the same clamp the Save path uses, so a preview can never ask for
 * a combination the row itself would be forbidden to hold.
 */
export function draftToOverrides(d: PresetDraft, seed?: number): SpeakOverrides {
  const instruction = d.instruction.trim() || null
  return {
    seed: seed ?? d.seed,
    instruction,
    cfgScale: clampCfgScale(d.cfgScale, instruction),
    temperature: d.temperature,
    topP: d.topP,
    topK: d.topK
  }
}

/** The four requests an audition sends — one per seed, all carrying the current draft. */
export function auditionRequests(
  draft: PresetDraft,
  presetId: string,
  text: string,
  rng: () => number = Math.random
): SpeakRequestBody[] {
  return auditionSeeds(draft.seed, rng).map(seed => ({
    text,
    presetId,
    // A complete file, so each take can be replayed from its own play button.
    format: 'wav' as const,
    overrides: draftToOverrides(draft, seed)
  }))
}

export interface AuditionHooks<T> {
  onStart?: (index: number) => void
  onDone?: (index: number, result: T) => void
  onError?: (index: number, err: unknown) => void
}

/**
 * Send each request IN TURN, awaiting every one before starting the next.
 *
 * The rig serves exactly one inference at a time: four requests in flight together means
 * one 200 and three 409s. `send` is the ONLY way this function can reach the network, so
 * there is no path by which an audition writes anything.
 *
 * A failing take is reported and the run continues — one bad seed should not cost the
 * other three.
 */
export async function runAuditionSequentially<T>(
  requests: SpeakRequestBody[],
  send: (body: SpeakRequestBody) => Promise<T>,
  hooks: AuditionHooks<T> = {}
): Promise<void> {
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i]
    if (!req) continue
    hooks.onStart?.(i)
    try {
      // `send` is awaited on its own line ON PURPOSE. Written as
      // `hooks.onDone?.(i, await send(req))`, optional chaining short-circuits the WHOLE
      // call expression when onDone is absent — arguments included — so the request would
      // silently never be sent for any caller that did not pass that hook.
      const result = await send(req)
      hooks.onDone?.(i, result)
    } catch (err) {
      hooks.onError?.(i, err)
    }
  }
}

// ── Event tags ────────────────────────────────────────────────────────────────

export const EVENT_TAGS = ['(laugh)', '(sigh)', '(cough)', '(clears throat)'] as const

/**
 * Insert `snippet` over the selection [start, end) of `value`, returning the new text and
 * where the caret belongs. Spacing is normalised so clicking (laugh) mid-sentence does
 * not produce `word(laugh)word` — Breeze reads an un-delimited tag as part of the word.
 */
export function insertAtCursor(
  value: string,
  snippet: string,
  start: number,
  end: number = start
): { value: string, cursor: number } {
  const from = Math.max(0, Math.min(start, value.length))
  const to = Math.max(from, Math.min(end, value.length))
  const before = value.slice(0, from)
  const after = value.slice(to)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const tail = after && !/^\s/.test(after) ? ' ' : ''
  const inserted = lead + snippet + tail
  return { value: before + inserted + after, cursor: from + lead.length + snippet.length }
}

// ── Reading a result ──────────────────────────────────────────────────────────

/** Roughly how many characters of text a second of speech carries (~170 wpm). Only used
 *  to decide whether a render came back implausibly short. */
const CHARS_PER_SECOND = 14

/** Below this fraction of the expected duration, the render did not finish. */
const TRUNCATION_RATIO = 0.35

export const TRUNCATION_MESSAGE
  = 'The rig accepted the request and then stopped early — that is what a prompt-ceiling '
    + 'overrun looks like from here (it answers 200 and dies, with no error to report). '
    + 'Shorten the text, or trim the reference clip, and try again.'

/**
 * Did this render come back truncated?
 *
 * A `truncated` failure can NEVER reach the client as a readable message: the rig sends
 * 200 OK and then dies mid-body, so the stream simply ends. The only evidence is that
 * far less audio arrived than the text called for, so that is what we test. Reporting a
 * generic "request failed" here sends the user hunting for a network problem that does
 * not exist.
 *
 * `audioBytes` is 16-bit mono PCM, excluding any WAV header.
 */
export function diagnoseTruncation(args: {
  chars: number
  audioBytes: number
  sampleRate: number
}): string | null {
  const { chars, audioBytes, sampleRate } = args
  if (chars <= 0) return null
  if (audioBytes <= 0) return TRUNCATION_MESSAGE
  if (sampleRate <= 0) return null
  const producedSeconds = audioBytes / (sampleRate * 2)
  const expectedSeconds = chars / CHARS_PER_SECOND
  return producedSeconds < expectedSeconds * TRUNCATION_RATIO ? TRUNCATION_MESSAGE : null
}

/**
 * What to tell the user after a STREAMED render, given everything the composable knows.
 *
 * Split out from the pane because the earlier version of this decision was wrong in a way
 * that reads as fine: it asked only whether the FIRST audio frame ever arrived, so a
 * stream that delivered one frame and then died — the commoner overrun shape — reported
 * nothing at all. It is the byte total that matters, not whether the total is zero.
 *
 * Returns null when there is nothing to add:
 *  - `error` is set, so the failure is already on screen with its own message;
 *  - the user pressed Stop, which produces exactly a truncation's shape (no error, little
 *    audio) and must never be reported as a prompt-ceiling overrun.
 */
export function diagnoseStreamRender(outcome: {
  chars: number
  audioBytes: number
  sampleRate: number
  error: string | null
  cancelled: boolean
}): string | null {
  if (outcome.error) return null
  if (outcome.cancelled) return null
  return diagnoseTruncation({
    chars: outcome.chars,
    audioBytes: outcome.audioBytes,
    sampleRate: outcome.sampleRate
  })
}

/**
 * Warn BEFORE spending a rig slot when the text is longer than this preset is calibrated
 * for. /api/voice/speak hands the text to Breeze in one piece — it does not segment the
 * way the agent pipeline does — so `maxSegmentChars` is a hard ceiling here, not a hint.
 */
export function overCapWarning(chars: number, maxSegmentChars: number): string | null {
  if (chars <= maxSegmentChars) return null
  return `${chars} characters is past this voice's calibrated ceiling of ${maxSegmentChars}. `
    + 'Studio synthesis sends the text in one piece, so the render will very likely stop early.'
}

/**
 * The message out of a failed request, wherever it is hiding. h3's createError puts
 * `statusMessage` on the FetchError's `data`, not on the error itself, so the obvious
 * `e.message` yields "[POST] /api/…: 400 Bad Request" and throws away the sentence the
 * server wrote — which, for the reference route, is the only place the 60s limit is
 * explained.
 */
export function errorMessage(e: unknown, fallback = 'Unknown error'): string {
  if (typeof e === 'string') return e || fallback
  const err = e as {
    data?: { statusMessage?: string, message?: string }
    statusMessage?: string
    message?: string
  }
  return err?.data?.statusMessage || err?.data?.message || err?.statusMessage || err?.message || fallback
}

/**
 * The sentence out of a failed `fetch` response body.
 *
 * `fetch` (unlike $fetch/ofetch) hands back an unparsed body, so `await res.text()` on an
 * h3 error is the whole JSON envelope — `{"statusCode":400,"statusMessage":"cfg_scale
 * above 1.0 requires an instruction…","stack":[]}` — and showing it verbatim buries the
 * one sentence that explains the failure inside punctuation. Parse first, then let
 * errorMessage pick the field.
 */
export function errorFromResponseBody(raw: string, fallback = 'Request failed'): string {
  const text = raw?.trim()
  if (!text) return fallback
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return errorMessage(JSON.parse(text), fallback)
    } catch {
      // Truncated or not actually JSON — fall through and show what arrived.
    }
  }
  return text
}

// ── MyMind content → something to read aloud ──────────────────────────────────

export interface ScriptMessage { role: 'user' | 'assistant', content: string }

/** A conversation read aloud is the assistant's side of it: the user's own turns are
 *  prompts, not prose, and hearing your own questions read back is noise. Falls back to
 *  the whole exchange when there is no assistant text at all. */
export function messagesToScript(messages: ScriptMessage[]): string {
  const assistant = messages.filter(m => m.role === 'assistant' && m.content.trim())
  const source = assistant.length ? assistant : messages.filter(m => m.content.trim())
  return source.map(m => m.content.trim()).join('\n\n')
}
