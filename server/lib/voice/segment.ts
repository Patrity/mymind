// server/lib/voice/segment.ts
// Replaces SentenceChunker. The old regex was /[^.!?]*[.!?]+(\s|$)/g, which split
// on EVERY period — so 192.168.2.25 became four separate TTS calls with a seam and a
// network round-trip between each. In an app whose agent talks about IPs, versions and
// dotted filenames constantly, that regex was the audible "unnatural pause".
import { toSpeakable } from './speakable'

const ABBREVIATIONS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'mt', 'vs', 'etc', 'approx',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'inc', 'ltd', 'co', 'fig', 'no', 'al',
  // Dotted two-letter abbreviations ("e.g.", "i.e.") are matched with their internal
  // dot stripped — see the word walk-back below.
  'eg', 'ie', 'am', 'pm'
])

const CLAUSE_BREAKS = [',', ';', ':', '—', '–']

/** True when the period at `i` ends a sentence rather than sitting inside a token. */
function isSentenceEnd(buf: string, i: number): boolean {
  const ch = buf[i]!
  if (ch !== '.' && ch !== '!' && ch !== '?') return false

  const next = buf[i + 1]
  // Must be followed by whitespace or end-of-buffer. This single check is what keeps a
  // COMPLETE dotted-numeric token (IPv4, a decimal, a version, "useVoice.ts") from ever
  // being split: every period INSIDE such a token is immediately followed by another
  // digit or letter ("192.168...", "3.6", ".ts"), never whitespace. So once a period is
  // followed by real whitespace (not end-of-buffer), a digit or letter immediately
  // before it can only mean the period is that token's own trailing sentence
  // punctuation (e.g. "...192.168.2.25. Next." or "It costs 5. Done."), not an internal
  // separator. The remaining ambiguity — end-of-buffer, which whitespace can't rule
  // out — is handled just below, since more digits may still be streaming in.
  if (next !== undefined && !/\s/.test(next)) return false

  if (ch === '.') {
    // Ellipsis: treat the whole run as non-terminal, so "check... it is" stays one segment.
    if (buf[i - 1] === '.' || buf[i + 1] === '.') return false

    // A period at the very end of the buffer, immediately preceded by a digit, is
    // ambiguous: the buffer may just be a streaming cut before the rest of a
    // dotted-numeric token arrives (push('192.168.') then push('2.25...'), or
    // push('Qwen 3.') then push('6 is loaded.')). Hold it in the tail rather than
    // guessing sentence-end — flush() sanitizes whatever is left at genuine end of
    // stream, so nothing is lost if this really was the final period. This is
    // narrower than the old digit walk-back: it only withholds judgement while more
    // input could still arrive (next === undefined); once a digit-preceded period is
    // followed by whitespace and more text, it IS the number's trailing sentence
    // punctuation ("It costs 25. Then we go.") and falls through to `return true` below.
    if (next === undefined && /\d/.test(buf[i - 1] ?? '')) return false

    // Known abbreviation immediately before the period. Walk back over letters, and over
    // a single internal dot that itself sits between two letters (so "e.g." collects as
    // "e.g", not just "g") — then compare with dots stripped.
    let j = i - 1
    let word = ''
    while (j >= 0) {
      const c = buf[j]!
      if (/[A-Za-z]/.test(c)) { word = c + word; j--; continue }
      if (c === '.' && j > 0 && /[A-Za-z]/.test(buf[j - 1]!)) { word = c + word; j--; continue }
      break
    }
    const normalized = word.toLowerCase().replace(/\./g, '')
    if (normalized && ABBREVIATIONS.has(normalized)) return false
  }
  return true
}

export function segment(buf: string, minChars = 140): { segments: string[]; tail: string } {
  const segments: string[] = []
  let start = 0

  const emit = (end: number) => {
    const raw = buf.slice(start, end)
    if (raw.trim()) segments.push(raw.trim())
    start = end
  }

  let fenceOpen = false
  // The length fallback is a one-shot safety valve per call: once it has cut a segment,
  // the rest of the buffer is left as tail even if it is also long. Streaming callers
  // (SpeechChunker) re-invoke segment() on every delta, so a still-growing tail gets
  // another chance to cut on the next push; a single large buffer with no natural
  // boundary is left intact rather than chopped into arbitrary same-size pieces.
  let lengthCutDone = false

  for (let i = 0; i < buf.length; i++) {
    // Track fenced code blocks (```). While inside an open fence, suspend all
    // splitting: code contains newlines and punctuation that are not spoken sentence
    // boundaries, and toSpeakable strips a *complete* fence as a single unit — cutting
    // a segment boundary inside one would leave half a fence for toSpeakable to see.
    if (buf[i] === '`' && buf[i + 1] === '`' && buf[i + 2] === '`') {
      fenceOpen = !fenceOpen
      i += 2
      continue
    }
    if (fenceOpen) continue

    // Newlines are hard boundaries — a list item or a heading ends a spoken unit.
    if (buf[i] === '\n') { emit(i); start = i + 1; continue }

    if (isSentenceEnd(buf, i)) {
      // Consume a run of terminators ("?!").
      let end = i + 1
      while (end < buf.length && /[.!?]/.test(buf[end]!)) end++
      emit(end)
      i = end - 1
      continue
    }

    // Length fallback: the old 60-char cap cut mid-word. Break at the last clause
    // boundary before the cap, else the last space.
    if (!lengthCutDone && i - start >= minChars) {
      const window = buf.slice(start, i + 1)
      let cut = -1
      for (const b of CLAUSE_BREAKS) cut = Math.max(cut, window.lastIndexOf(b))
      if (cut < 0) cut = window.lastIndexOf(' ') - 1
      if (cut > 0) { emit(start + cut + 1); i = start - 1; lengthCutDone = true }
    }
  }

  return { segments, tail: buf.slice(start) }
}

/**
 * Accumulates raw deltas, segments the RAW buffer, and sanitizes each COMPLETED
 * segment. Order matters: markdown markers span deltas ("**" / "bold" / "**" can
 * arrive as three), so sanitizing per-delta would see half-markers, and sanitizing
 * the whole buffer before segmenting would mean mapping sanitized offsets back to
 * raw to know what to retain. Segment-then-sanitize avoids both.
 */
export class SpeechChunker {
  private buf = ''
  constructor(private minChars = 140) {}

  push(delta: string): string[] {
    this.buf += delta
    const { segments, tail } = segment(this.buf, this.minChars)
    this.buf = tail
    return segments.map(toSpeakable).filter(s => s.length > 0)
  }

  flush(): string[] {
    const rest = this.buf
    this.buf = ''
    const spoken = toSpeakable(rest)
    return spoken ? [spoken] : []
  }
}
