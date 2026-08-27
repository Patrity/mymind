# Agent Surface Redesign Implementation Plan (cycle 60)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/agent` as a three-column surface where the conversation is the page, make the voice pipeline deterministic before swapping Kokoro for Orpheus, and give Bridget a particle-head face driven by the existing GPU core.

**Architecture:** The page becomes three `UDashboardPanel`s (threads / conversation / Bridget). Two new pure server modules (`speakable.ts`, `segment.ts`) sit between the model's token stream and the TTS synth, replacing `SentenceChunker`. The visualizer moves behind a small `Avatar` interface whose only implementation, `ParticleHead`, samples its point positions from a MakeHuman-derived point buffer baked at build time rather than a sphere. Choreography is pure TS with an injected RNG.

**Tech Stack:** Nuxt 4 (SPA), Vue 3, Nuxt UI v3 (reka-ui), Tailwind, Three.js, Drizzle/Postgres, vitest, `playwright-cli` for browser validation.

**Spec:** [`docs/superpowers/specs/2026-08-27-agent-surface-redesign-design.md`](../specs/2026-08-27-agent-surface-redesign-design.md)

## Global Constraints

- **Package manager is `pnpm`.** Never npm or yarn.
- **Gates:** `pnpm typecheck` (0 errors), `pnpm test` (vitest), `pnpm build`. Lint is red repo-wide and is NOT a gate.
- **Browser validation uses `playwright-cli`, never the Playwright MCP** (project rule `.claude/rules/web-vue-ui.md`).
- **Dev credentials:** `test@example.com` / `testpassword123`. Dev server `pnpm dev` → `http://localhost:3000`. Dev Postgres is the Docker container `mymind-db` (start Docker Desktop first).
- **`<MdView>`'s `cache-key` must stay unique per transcript entry.** Cycle 41: streamed replies sharing a first delta collide on MDC's `hash(value)` asyncData key and render each other's content. Never drop or reuse the key.
- **Sanitized speech text must never reach the transcript or the database.** `conversation_messages.content` stays raw markdown. `toSpeakable` output is consumed only by the TTS synth.
- **Never write a `[image]` marker or image markdown into assistant text.** The orchestrator authors image embeds itself (cycle 37).
- **`USelectMenu` / reka-ui `ComboboxItem` reject an empty-string item value.** Use a non-empty sentinel and map it back.
- **reka-ui components need a real `playwright-cli click <ref>`.** A programmatic `el.click()` in `eval` does not fire their handlers.
- **Commit after every task.** No co-author trailers, no model references in commit messages.

---

## File Structure

**New — server:**
- `server/lib/voice/speakable.ts` — pure markdown→speech normalizer.
- `server/lib/voice/speakable.test.ts`
- `server/lib/voice/segment.ts` — pure sentence/clause segmenter, replaces `SentenceChunker`'s regex.
- `server/lib/voice/segment.test.ts`

**New — client:**
- `app/lib/avatar/types.ts` — the `Avatar` interface.
- `app/lib/avatar/choreography.ts` — pure pose/brightness state machine with injected RNG.
- `app/lib/avatar/choreography.test.ts`
- `app/lib/avatar/particle-head.ts` — the one `Avatar` implementation; owns the existing `lib/viz/*` internals.
- `app/components/agent/Avatar.client.vue` — thin mount (RAF, analysers, resize, context-loss).
- `app/components/agent/MicBand.vue` — FFT bars + speech-probability track.
- `app/components/agent/ThreadRail.vue` — permanent conversation list.
- `app/components/agent/Toolbar.vue` — the single toolbar (replaces two duplicated blocks).
- `app/components/agent/MessageActions.vue` — copy / retry / timestamp / tokens.
- `app/components/agent/EmptyState.vue`
- `scripts/bake-head.ts` — mesh → point buffer, build-time only.

**Modified:**
- `app/pages/agent/index.vue` — rewritten as the three-column shell.
- `app/components/voice/Transcript.vue` — turn separation, autoscroll, actions row.
- `app/components/voice/Composer.vue` — textarea, shift-enter, Stop.
- `app/components/voice/SettingsSlideover.vue` — microphone picker.
- `app/composables/useVoice.ts` — `deviceId` constraint, `stop()`, `usage` capture.
- `app/composables/useVoiceSettings.ts` — `micDeviceId`.
- `app/layouts/default.vue` — Conversations sidebar entry.
- `app/pages/agent/history.vue` — delete confirmation.
- `server/lib/voice/orchestrator.ts` — new chunking chain.
- `server/lib/voice/tuning.ts` — `playbackRate` 1.0, `sentenceMinChars` 140.
- `server/db/schema/conversations.ts` — `usage jsonb`.
- `server/services/conversations.ts` — persist/return `usage`.
- `server/api/voice/ws.ts` — capture usage.

**Deleted:**
- `server/lib/voice/chunker.ts` + its tests (superseded by `segment.ts`).
- `app/lib/viz/ring.ts` (the 96-bar ring is retired).

---

## Task 1: `toSpeakable` — the markdown→speech normalizer

**Files:**
- Create: `server/lib/voice/speakable.ts`
- Test: `server/lib/voice/speakable.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function toSpeakable(text: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// server/lib/voice/speakable.test.ts
import { describe, it, expect } from 'vitest'
import { toSpeakable } from './speakable'

describe('toSpeakable', () => {
  it('strips emphasis markers but keeps the words', () => {
    expect(toSpeakable('Here are your **6 active projects**:')).toBe('Here are your 6 active projects:')
    expect(toSpeakable('that is _really_ important')).toBe('that is really important')
    expect(toSpeakable('a __bold__ and *italic* mix')).toBe('a bold and italic mix')
  })

  it('strips heading markers', () => {
    expect(toSpeakable('# Deploying a Nuxt App')).toBe('Deploying a Nuxt App')
    expect(toSpeakable('## 1. Provision the LXC')).toBe('1. Provision the LXC')
  })

  it('strips list bullets but keeps ordered numbering', () => {
    expect(toSpeakable('- mymind is the app')).toBe('mymind is the app')
    expect(toSpeakable('* another item')).toBe('another item')
    expect(toSpeakable('2. second step')).toBe('2. second step')
  })

  it('keeps link labels and drops the URL', () => {
    expect(toSpeakable('see [the roadmap](https://example.com/x)')).toBe('see the roadmap')
  })

  it('drops fenced code blocks entirely', () => {
    expect(toSpeakable('Run this:\n```bash\npnpm dev --port 3000\n```\nthen open it'))
      .toBe('Run this: then open it')
  })

  it('reads inline code as its content without backticks', () => {
    expect(toSpeakable('set `playbackRate` to one')).toBe('set playbackRate to one')
  })

  it('drops tables', () => {
    expect(toSpeakable('Results:\n| a | b |\n|---|---|\n| 1 | 2 |\ndone')).toBe('Results: done')
  })

  it('drops blockquote markers and horizontal rules', () => {
    expect(toSpeakable('> quoted thing')).toBe('quoted thing')
    expect(toSpeakable('before\n---\nafter')).toBe('before after')
  })

  it('expands an IPv4 address digit-group by digit-group', () => {
    expect(toSpeakable('the rig is at 192.168.2.25'))
      .toBe('the rig is at one ninety two dot one sixty eight dot two dot twenty five')
  })

  it('expands a version number', () => {
    expect(toSpeakable('running v1.2 now')).toBe('running version one point two now')
    expect(toSpeakable('Qwen 3.6 is the model')).toBe('Qwen three point six is the model')
  })

  it('speaks a leading-slash path as a page name', () => {
    expect(toSpeakable('open /agent to see it')).toBe('open the agent page to see it')
  })

  it('collapses the whitespace it creates', () => {
    expect(toSpeakable('**a**\n\n\n**b**')).toBe('a b')
  })

  it('returns plain prose untouched', () => {
    const s = 'Your six active projects are mymind and bridget-services.'
    expect(toSpeakable(s)).toBe(s)
  })

  it('never throws on malformed markdown', () => {
    expect(() => toSpeakable('**unclosed and ```also unclosed')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/lib/voice/speakable.test.ts`
Expected: FAIL — `Failed to resolve import "./speakable"`.

- [ ] **Step 3: Write the implementation**

```ts
// server/lib/voice/speakable.ts
// Deterministic markdown -> speech normalizer. The system prompt ASKS the model not
// to emit markdown in speak mode; this is what ENFORCES it. Same reasoning as the
// cycle-37 image-URL fix: never trust the model with a formatting invariant.
//
// Consumed ONLY by the TTS path. The transcript and conversation_messages.content
// keep the raw markdown — this must never round-trip into storage or the UI.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/** 0-999 as words. Above that, fall back to the digits so we never mangle a big number. */
function numberToWords(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 999) return String(n)
  if (n < 10) return ONES[n]!
  if (n < 20) return TEENS[n - 10]!
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)]!
    const r = n % 10
    return r ? `${t} ${ONES[r]!}` : t
  }
  const h = `${ONES[Math.floor(n / 100)]!} hundred`
  const r = n % 100
  return r ? `${h} ${numberToWords(r)}` : h
}

/** Digits spoken one at a time — for the fractional part of a version. */
function digitsToWords(s: string): string {
  return s.split('').map(d => ONES[Number(d)] ?? d).join(' ')
}

export function toSpeakable(text: string): string {
  let s = text

  // Fenced code blocks first, before anything can chew their contents.
  s = s.replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(/```[\s\S]*$/g, ' ')          // unterminated fence at end of stream

  // Table rows (any line that is pipe-delimited) and separator rows.
  s = s.replace(/^\s*\|.*\|\s*$/gm, ' ')

  // Horizontal rules.
  s = s.replace(/^\s*([-*_])\s*(?:\1\s*){2,}$/gm, ' ')

  // Headings and blockquotes.
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  s = s.replace(/^\s{0,3}>\s?/gm, '')

  // Unordered list bullets. Ordered lists keep their number (it carries meaning).
  s = s.replace(/^\s*[-*+]\s+/gm, '')

  // Links and images: keep the label, drop the target.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')

  // Inline code -> its contents.
  s = s.replace(/`([^`]*)`/g, '$1')

  // Emphasis. Longest markers first so ** is not eaten as two *.
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  s = s.replace(/\*([^*\n]+)\*/g, '$1')
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g, '$1$2')
  s = s.replace(/[*_]{1,3}/g, '')             // orphaned markers from an unclosed span

  // IPv4 -> spoken groups. Before the version rule, which would otherwise
  // claim the first two octets.
  s = s.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g,
    (_m, a, b, c, d) => [a, b, c, d].map((g: string) => numberToWords(Number(g))).join(' dot '))

  // Versions: "v1.2" and a bare "3.6". Integer part as a number, fraction digit-by-digit.
  s = s.replace(/\bv(\d+)\.(\d+)\b/gi,
    (_m, maj, min) => `version ${numberToWords(Number(maj))} point ${digitsToWords(min)}`)
  s = s.replace(/\b(\d+)\.(\d+)\b/g,
    (_m, maj, min) => `${numberToWords(Number(maj))} point ${digitsToWords(min)}`)

  // App routes read as page names rather than spelled slashes.
  s = s.replace(/(^|\s)\/([a-z][a-z0-9-]*)\b/g, '$1the $2 page')

  // Collapse whatever whitespace the removals created.
  return s.replace(/\s+/g, ' ').trim()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/lib/voice/speakable.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add server/lib/voice/speakable.ts server/lib/voice/speakable.test.ts
git commit -m "feat(voice): add toSpeakable, a deterministic markdown-to-speech normalizer"
```

---

## Task 2: `segment` — the sentence/clause segmenter

**Files:**
- Create: `server/lib/voice/segment.ts`
- Test: `server/lib/voice/segment.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function segment(buf: string, minChars?: number): { segments: string[]; tail: string }`
  - `export class SpeechChunker { push(delta: string): string[]; flush(): string[] }`

`SpeechChunker` is the drop-in replacement for `SentenceChunker`. It holds a **raw** buffer, segments the raw text, and runs `toSpeakable` on each *completed* segment before emitting. Ordering is deliberate: markdown markers span deltas, so sanitizing earlier would see half-markers, and sanitizing the whole buffer then segmenting would require mapping sanitized offsets back to raw.

- [ ] **Step 1: Write the failing test**

```ts
// server/lib/voice/segment.test.ts
import { describe, it, expect } from 'vitest'
import { segment, SpeechChunker } from './segment'

describe('segment', () => {
  it('splits on sentence-final punctuation followed by space', () => {
    expect(segment('One thing. Two things! Three?', 999)).toEqual({
      segments: ['One thing.', 'Two things!', 'Three?'],
      tail: ''
    })
  })

  it('retains an unterminated tail', () => {
    expect(segment('Done. And then I', 999)).toEqual({ segments: ['Done.'], tail: ' And then I' })
  })

  it('does NOT split inside an IPv4 address', () => {
    const r = segment('The rig is at 192.168.2.25 today. Next.', 999)
    expect(r.segments).toEqual(['The rig is at 192.168.2.25 today.', 'Next.'])
  })

  it('does NOT split inside a decimal', () => {
    expect(segment('Qwen 3.6 is loaded. Good.', 999).segments)
      .toEqual(['Qwen 3.6 is loaded.', 'Good.'])
  })

  it('does NOT split after a known abbreviation', () => {
    expect(segment('Ask Dr. Smith about it. Then go.', 999).segments)
      .toEqual(['Ask Dr. Smith about it.', 'Then go.'])
    expect(segment('Use a tool, e.g. search_docs, first. Then reply.', 999).segments)
      .toEqual(['Use a tool, e.g. search_docs, first.', 'Then reply.'])
  })

  it('does NOT split inside a dotted identifier or file extension', () => {
    expect(segment('Open useVoice.ts now. Done.', 999).segments)
      .toEqual(['Open useVoice.ts now.', 'Done.'])
  })

  it('does NOT split on an ellipsis mid-sentence', () => {
    expect(segment('Let me check... it is there. Yes.', 999).segments)
      .toEqual(['Let me check... it is there.', 'Yes.'])
  })

  it('treats a newline as a hard boundary', () => {
    expect(segment('First line\nSecond line\n', 999).segments)
      .toEqual(['First line', 'Second line'])
  })

  it('breaks at the last clause boundary when it exceeds minChars', () => {
    const long = 'this clause is quite long indeed, and this second clause pushes it over the cap and keeps going'
    const r = segment(long, 40)
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0]).toBe('this clause is quite long indeed,')
    expect(r.tail).toBe(' and this second clause pushes it over the cap and keeps going')
  })

  it('falls back to the last space when there is no clause boundary', () => {
    const long = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk'
    const r = segment(long, 20)
    expect(r.segments[0]!.endsWith('dddd') || r.segments[0]!.endsWith('eeee')).toBe(true)
    expect(r.segments[0]!.length).toBeLessThanOrEqual(20 + 5)
  })

  it('never emits an empty segment', () => {
    expect(segment('...   \n\n  ', 999).segments.every(s => s.trim().length > 0)).toBe(true)
  })
})

describe('SpeechChunker', () => {
  it('sanitizes only completed segments and holds the tail', () => {
    const c = new SpeechChunker(999)
    expect(c.push('Here are your **6 ')).toEqual([])
    expect(c.push('active projects**. ')).toEqual(['Here are your 6 active projects.'])
    expect(c.push('More to come')).toEqual([])
    expect(c.flush()).toEqual(['More to come'])
  })

  it('does not emit half a markdown marker when a delta splits one', () => {
    const c = new SpeechChunker(999)
    c.push('that is **')
    c.push('bold')
    const out = c.push('** text. ')
    expect(out).toEqual(['that is bold text.'])
    expect(out.join('')).not.toContain('*')
  })

  it('drops a segment that sanitizes to nothing', () => {
    const c = new SpeechChunker(999)
    expect(c.push('```\ncode\n```\n')).toEqual([])
  })

  it('does not fragment an IP across synth calls', () => {
    const c = new SpeechChunker(999)
    c.push('The rig is at 192.168.2.25 and it works. ')
    // one segment, not four
    expect(c.flush()).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/lib/voice/segment.test.ts`
Expected: FAIL — `Failed to resolve import "./segment"`.

- [ ] **Step 3: Write the implementation**

```ts
// server/lib/voice/segment.ts
// Replaces SentenceChunker. The old regex was /[^.!?]*[.!?]+(\s|$)/g, which split
// on EVERY period — so 192.168.2.25 became four separate TTS calls with a seam and a
// network round-trip between each. In an app whose agent talks about IPs, versions and
// dotted filenames constantly, that regex was the audible "unnatural pause".
import { toSpeakable } from './speakable'

const ABBREVIATIONS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'mt', 'vs', 'etc', 'approx',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'inc', 'ltd', 'co', 'fig', 'no', 'al'
])

const CLAUSE_BREAKS = [',', ';', ':', '—', '–']

/** True when the period at `i` ends a sentence rather than sitting inside a token. */
function isSentenceEnd(buf: string, i: number): boolean {
  const ch = buf[i]!
  if (ch !== '.' && ch !== '!' && ch !== '?') return false

  const next = buf[i + 1]
  // Must be followed by whitespace or end-of-buffer. "3.6" and "useVoice.ts" fail here.
  if (next !== undefined && !/\s/.test(next)) return false

  if (ch === '.') {
    // Ellipsis: treat the whole run as non-terminal, so "check... it is" stays one segment.
    if (buf[i - 1] === '.' || buf[i + 1] === '.') return false

    // Digit before AND after (across the run) => a number. Handled by the `next` check
    // above for "3.6", but "2." at the end of "192.168.2.25 " needs the digit-before test
    // combined with a digit-led token earlier — cheapest reliable guard is: a digit
    // immediately before a period that ends a dotted-numeric run.
    if (/\d/.test(buf[i - 1] ?? '')) {
      // Walk back over digits and dots; if we started on a digit, this is a numeric token.
      let j = i - 1
      while (j >= 0 && /[\d.]/.test(buf[j]!)) j--
      if (/\d/.test(buf[j + 1] ?? '')) return false
    }

    // Known abbreviation immediately before the period.
    let j = i - 1
    let word = ''
    while (j >= 0 && /[A-Za-z]/.test(buf[j]!)) { word = buf[j]! + word; j-- }
    if (word && ABBREVIATIONS.has(word.toLowerCase())) return false
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

  for (let i = 0; i < buf.length; i++) {
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
    if (i - start >= minChars) {
      const window = buf.slice(start, i + 1)
      let cut = -1
      for (const b of CLAUSE_BREAKS) cut = Math.max(cut, window.lastIndexOf(b))
      if (cut < 0) cut = window.lastIndexOf(' ') - 1
      if (cut > 0) { emit(start + cut + 1); i = start - 1 }
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/lib/voice/segment.test.ts`
Expected: PASS, 15 tests. If the IPv4 guard fails, the walk-back in `isSentenceEnd` is the place to fix — do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add server/lib/voice/segment.ts server/lib/voice/segment.test.ts
git commit -m "feat(voice): add a decimal- and abbreviation-aware speech segmenter"
```

---

## Task 3: Wire the new chain into the orchestrator; retire `SentenceChunker`

**Files:**
- Modify: `server/lib/voice/orchestrator.ts:2` (import), `:79` (construction), `:106` and `:133` (call sites)
- Modify: `server/lib/voice/tuning.ts:8`
- Delete: `server/lib/voice/chunker.ts`, and any `chunker` test file if present
- Test: `server/lib/voice/orchestrator-speakable.test.ts` (create)

**Interfaces:**
- Consumes: `SpeechChunker` from Task 2.
- Produces: no new exports. `handleTurn`'s persisted `assistantText` is unchanged (raw markdown).

- [ ] **Step 1: Write the failing test**

```ts
// server/lib/voice/orchestrator-speakable.test.ts
import { describe, it, expect } from 'vitest'
import { handleTurn } from './orchestrator'
import type { AgentEvent } from '../agent/run'

function fakeDeps(spoken: string[]) {
  return {
    tts: {
      async *synthesize(text: string) { spoken.push(text); yield new Uint8Array([1]) }
    } as never,
    voice: 'af_heart',
    signal: new AbortController().signal,
    speak: true,
    emit: () => {},
    async *runAgent(): AsyncGenerator<AgentEvent> {
      yield { type: 'text-delta', text: 'Here are your **6 ' } as AgentEvent
      yield { type: 'text-delta', text: 'projects**. The rig is at 192.168.2.25 today. ' } as AgentEvent
    }
  }
}

describe('handleTurn speech path', () => {
  it('speaks sanitized text and never sends markdown to the synth', async () => {
    const spoken: string[] = []
    await handleTurn('hi', [], fakeDeps(spoken) as never)
    expect(spoken.join(' ')).not.toContain('*')
    expect(spoken.join(' ')).toContain('6 projects')
  })

  it('does not fragment an IP address into separate synth calls', async () => {
    const spoken: string[] = []
    await handleTurn('hi', [], fakeDeps(spoken) as never)
    const ipCalls = spoken.filter(s => s.includes('dot'))
    expect(ipCalls).toHaveLength(1)
  })

  it('persists RAW markdown to history, not the spoken form', async () => {
    const spoken: string[] = []
    const out = await handleTurn('hi', [], fakeDeps(spoken) as never)
    const last = out[out.length - 1] as { role: string; content: string }
    expect(last.role).toBe('assistant')
    expect(last.content).toContain('**')
    expect(last.content).toContain('192.168.2.25')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/lib/voice/orchestrator-speakable.test.ts`
Expected: FAIL — markdown reaches the synth, and the IP is split into several `dot`-bearing calls.

- [ ] **Step 3: Make the changes**

In `server/lib/voice/orchestrator.ts`, replace the import on line 2:

```ts
import { SpeechChunker } from './segment'
```

Replace the construction (line 79):

```ts
  const chunker = new SpeechChunker(VOICE_TUNING.tts.sentenceMinChars)
```

The two call sites (lines 106 and 133) keep their exact shape — `chunker.push(ev.text)` and `chunker.flush()` — because `SpeechChunker` matches `SentenceChunker`'s signature. No other change in this file.

In `server/lib/voice/tuning.ts`:

```ts
  // sentenceMinChars: the old 60 cut mid-clause, and each cut is a separate TTS call
  // with a seam and a round-trip. 140 with a clause-aware break (see segment.ts).
  // playbackRate: 1.0 — 1.1 compressed whatever prosody the model produced and read
  // as rushed. Users can still change it in the settings slideover.
  tts:     { provider: 'kokoro' as 'chatterbox' | 'kokoro', sentenceMinChars: 140, playbackRate: 1.0 },
```

Then delete the superseded module:

```bash
rm server/lib/voice/chunker.ts
rm -f server/lib/voice/chunker.test.ts
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run server/lib/voice/ && pnpm typecheck`
Expected: PASS. If any surviving test imports `./chunker`, delete that test — `segment.test.ts` supersedes its coverage.

- [ ] **Step 5: Commit**

```bash
git add -A server/lib/voice/
git commit -m "feat(voice): route TTS through the sanitizing segmenter, drop SentenceChunker"
```

---

## Task 4: `usage jsonb` on conversation messages

**Files:**
- Modify: `server/db/schema/conversations.ts`
- Modify: `server/services/conversations.ts`
- Modify: `server/api/voice/ws.ts`
- Create: migration under `server/db/migrations/` (generated)
- Test: `test/conversation-usage.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `ConversationMessageDTO.usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null`

- [ ] **Step 1: Write the failing test**

```ts
// test/conversation-usage.test.ts
import { describe, it, expect } from 'vitest'
import { conversationMessages } from '../server/db/schema/conversations'

describe('conversation_messages.usage', () => {
  it('exposes a usage column on the schema', () => {
    expect(Object.keys(conversationMessages)).toContain('usage')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/conversation-usage.test.ts`
Expected: FAIL — `usage` is not a key.

- [ ] **Step 3: Add the column, the migration, and the plumbing**

In `server/db/schema/conversations.ts`, add to `conversationMessages` after `attachments`:

```ts
  // Per-turn model usage from streamText, for the transcript's token readout.
  // Nullable and additive: messages written before this column omit the count
  // rather than showing a zero. { inputTokens, outputTokens, totalTokens }.
  usage: jsonb('usage'),
```

Generate and apply:

```bash
pnpm db:generate
pnpm db:migrate
```

In `server/services/conversations.ts`: add `usage` to the `appendMessages` insert payload (accepting it on the assistant-message input type) and select it in `getConversation`'s DTO mapping. Do **not** add it to `getAgentHistory` — that read is the model's context and must stay `role` + `content` only.

In `server/api/voice/ws.ts`: the `emit` closure already accumulates `tool_calls` and `reasoning` for the assistant turn. Accumulate usage the same way and pass it through on the assistant row.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/conversation-usage.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A server/db server/services/conversations.ts server/api/voice/ws.ts test/conversation-usage.test.ts
git commit -m "feat(agent): persist per-message model usage for the transcript token readout"
```

---

## Task 5: Sidebar entry for Conversations, and a delete confirmation

**Files:**
- Modify: `app/layouts/default.vue:64`
- Modify: `app/pages/agent/history.vue:169`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

This is the actual fix for "no ability to view past conversations" — the page was always complete, it just had no way in.

- [ ] **Step 1: Add the sidebar entry**

In `app/layouts/default.vue`, immediately after the existing `{ label: 'Agent', icon: 'i-lucide-bot', to: '/agent' }` entry:

```ts
  { label: 'Conversations', icon: 'i-lucide-messages-square', to: '/agent/history' },
```

- [ ] **Step 2: Add the delete confirmation**

In `app/pages/agent/history.vue`, add a pending-delete ref and a `UModal`, and change the trash button to open it rather than deleting:

```ts
const confirmId = ref<string | null>(null)
const confirmTitle = computed(() =>
  conversations.value.find(c => c.id === confirmId.value)?.title || 'this conversation')

async function confirmDelete() {
  const id = confirmId.value
  confirmId.value = null
  if (id) await doDelete(id)
}
```

Change the row button's handler to `@click.stop="confirmId = c.id"`, and add before `</template>` of the panel body:

```vue
<UModal
  :open="!!confirmId"
  title="Delete conversation?"
  :description="`“${confirmTitle}” and all of its messages will be permanently deleted. This cannot be undone.`"
  @update:open="(v: boolean) => { if (!v) confirmId = null }"
>
  <template #footer>
    <div class="flex justify-end gap-2 w-full">
      <UButton label="Cancel" color="neutral" variant="ghost" @click="confirmId = null" />
      <UButton label="Delete" color="error" @click="confirmDelete" />
    </div>
  </template>
</UModal>
```

- [ ] **Step 3: Browser-validate**

```bash
pnpm dev &
playwright-cli goto "http://localhost:3000/login"
# sign in as test@example.com / testpassword123, then:
playwright-cli goto "http://localhost:3000/"
playwright-cli snapshot | grep -i "Conversations"
```
Expected: a `Conversations` link is present in the sidebar. Click it (real `playwright-cli click <ref>`), confirm it lands on `/agent/history`, hover a row, click the trash, and confirm the modal appears **without** deleting. Cancel, verify the row survives.

- [ ] **Step 4: Run the gates**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/layouts/default.vue app/pages/agent/history.vue
git commit -m "feat(agent): surface Conversations in the sidebar and confirm before deleting one"
```

---

## Task 6: The three-column shell

**Files:**
- Modify: `app/pages/agent/index.vue` (rewritten)
- Create: `app/components/agent/Toolbar.vue`
- Create: `app/components/agent/ThreadRail.vue`

**Interfaces:**
- Consumes: `useConversations()`, `useVoice()`, `useAiConfig()`.
- Produces:
  - `<AgentToolbar :title="string | null" v-model:speak="boolean" v-model:model="string" @settings="() => void" @full-bleed="() => void" />`
  - `<AgentThreadRail :active-id="string | null" @select="(id: string) => void" @new="() => void" />`

**Layout constraint (do not fight it):** Nuxt UI's resize handle only supports a sized panel to its **left**. So `agent-threads` is sized (handle 1 to its right), `agent-conversation` is sized (handle 2 to its right), and `agent-bridget` is the fluid remainder with a CSS clamp. See `docs/wiki/voice-agent.md`.

- [ ] **Step 1: Write `ThreadRail.vue`**

```vue
<!-- app/components/agent/ThreadRail.vue -->
<script setup lang="ts">
const props = defineProps<{ activeId: string | null }>()
const emit = defineEmits<{ select: [id: string]; new: [] }>()

const q = ref('')
const { useConversationList } = useConversations()
const { data } = useConversationList(() => ({ q: q.value.trim() || undefined }))
const conversations = computed(() => data.value ?? [])

/** Group by Today / Yesterday / date — the rail's only structural device. */
const groups = computed(() => {
  const out = new Map<string, typeof conversations.value>()
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yest = new Date(today); yest.setDate(yest.getDate() - 1)
  for (const c of conversations.value) {
    const d = c.lastMessageAt ? new Date(c.lastMessageAt) : null
    const key = !d ? 'Earlier'
      : d >= today ? 'Today'
      : d >= yest ? 'Yesterday'
      : d.toLocaleDateString()
    if (!out.has(key)) out.set(key, [])
    out.get(key)!.push(c)
  }
  return [...out.entries()]
})
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="p-2 flex flex-col gap-2 border-b border-default">
      <UButton
        block
        icon="i-lucide-plus"
        label="New conversation"
        size="sm"
        color="neutral"
        variant="soft"
        @click="emit('new')"
      />
      <UInput
        v-model="q"
        icon="i-lucide-search"
        placeholder="Search…"
        size="sm"
      />
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-3">
      <div
        v-for="[label, items] in groups"
        :key="label"
        class="flex flex-col gap-0.5"
      >
        <span class="px-2 text-[10px] font-medium uppercase tracking-wider text-dimmed">{{ label }}</span>
        <UButton
          v-for="c in items"
          :key="c.id"
          block
          variant="ghost"
          :color="c.id === props.activeId ? 'primary' : 'neutral'"
          class="text-left"
          @click="emit('select', c.id)"
        >
          <div class="flex flex-col gap-0.5 w-full min-w-0">
            <span class="text-sm truncate">{{ c.title || 'New conversation' }}</span>
            <span class="text-xs text-muted truncate">{{ c.messageCount }} messages</span>
          </div>
        </UButton>
      </div>

      <p
        v-if="!conversations.length"
        class="px-3 py-8 text-center text-sm text-muted"
      >
        {{ q.trim() ? 'No matches.' : 'No conversations yet.' }}
      </p>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Write `Toolbar.vue`**

One copy only. The old page had this block duplicated verbatim in two template branches (lines 160–200 and 218–258) — that is what this task deletes.

```vue
<!-- app/components/agent/Toolbar.vue -->
<script setup lang="ts">
defineProps<{ title: string | null }>()
const speak = defineModel<boolean>('speak', { required: true })
const model = defineModel<string>('model', { required: true })
const emit = defineEmits<{ settings: []; fullBleed: [] }>()

const DEFAULT_MODEL = '__default__'
const { draft: aiDraft } = useAiConfig()
const modelItems = computed(() => {
  const models = aiDraft.value.models
  const chain = (aiDraft.value.assignments.reasoning ?? [])
    .map(id => models.find(m => m.id === id))
    .filter((m): m is NonNullable<typeof m> => !!m)
  return [{ label: 'Default (chain order)', value: DEFAULT_MODEL }, ...chain.map(m => ({ label: m.label, value: m.id }))]
})
</script>

<template>
  <UDashboardNavbar :title="title || 'Bridget'">
    <template #leading>
      <UDashboardSidebarCollapse />
    </template>
    <template #right>
      <USwitch
        v-model="speak"
        label="Voice replies"
        size="sm"
      />
      <UButton
        icon="i-lucide-maximize-2"
        variant="ghost"
        color="neutral"
        aria-label="Full-screen voice mode"
        @click="emit('fullBleed')"
      />
      <USelectMenu
        v-model="model"
        :items="modelItems"
        value-key="value"
        icon="i-lucide-cpu"
        size="sm"
        class="w-44"
        aria-label="Agent model"
      />
      <UButton
        icon="i-lucide-settings"
        variant="ghost"
        color="neutral"
        aria-label="Voice settings"
        @click="emit('settings')"
      />
    </template>
  </UDashboardNavbar>
</template>
```

- [ ] **Step 3: Rewrite the page shell**

`app/pages/agent/index.vue` keeps its existing `?q=` handoff logic, `?c=` resume, `resume()`, `undoTool()`, and `toggleMic()` verbatim — only the template and the panel structure change. Replace the whole `<template>` with:

```vue
<template>
  <div class="flex flex-1 min-w-0 h-full">
    <!-- Threads: sized + resizable + collapsible. Hidden under lg; reachable
         from the toolbar's slideover there. -->
    <UDashboardPanel
      id="agent-threads"
      resizable
      collapsible
      :default-size="14"
      :min-size="10"
      :max-size="24"
      class="hidden lg:flex"
      :ui="{ body: '!p-0 !gap-0' }"
    >
      <template #body>
        <AgentThreadRail
          :active-id="activeConversationId"
          @select="resume"
          @new="voice.newConversation()"
        />
      </template>
    </UDashboardPanel>

    <!-- Conversation: sized (it carries the second handle) and ALWAYS rendered.
         The old `hidden lg:flex` here is what made the page unusable below 1024px. -->
    <UDashboardPanel
      id="agent-conversation"
      resizable
      :default-size="58"
      :min-size="35"
      :max-size="80"
      :ui="{ body: '!p-0 !gap-0' }"
    >
      <template #header>
        <AgentToolbar
          v-model:speak="speakReply"
          v-model:model="selectedModel"
          :title="activeTitle"
          @settings="settingsOpen = true"
          @full-bleed="fullBleed = true"
        />
      </template>
      <template #body>
        <VoiceTranscript
          class="flex-1 min-h-0"
          :entries="voice.transcript.value"
          @undo="undoTool"
          @retry="retryTurn"
        />
        <div v-if="voice.pendingApproval.value" class="px-4 pb-2">
          <AgentApprovalPrompt
            :approval="voice.pendingApproval.value"
            @approve="(d) => voice.sendApproval(voice.pendingApproval.value!.requestId, true, d)"
            @deny="() => voice.sendApproval(voice.pendingApproval.value!.requestId, false)"
          />
        </div>
        <VoiceComposer
          :entries="voice.transcript.value"
          :send-text="voice.sendText"
          :speak="speakReply"
          :busy="isBusy"
          :initial-text="initialComposerText"
          :auto-send="!!initialComposerText"
          :mic-on="micOn"
          @stop="voice.stop"
          @toggle-mic="toggleMic"
        />
      </template>
    </UDashboardPanel>

    <!-- Bridget: the fluid remainder. Clamped in CSS because Nuxt UI cannot size
         a panel to the RIGHT of a handle. -->
    <UDashboardPanel
      id="agent-bridget"
      class="hidden lg:flex min-w-[240px] max-w-[420px]"
      :ui="{ body: '!p-0 !gap-0 overflow-hidden' }"
    >
      <template #body>
        <div class="relative flex flex-col flex-1 min-h-0 bg-black">
          <AgentAvatar
            class="flex-1 min-h-0"
            :state="voice.state.value"
            :connected="voice.connected.value"
            :mic-analyser="voice.micAnalyser"
            :out-analyser="voice.outAnalyser"
            :on-viz-event="voice.onVizEvent"
          />
          <AgentMicBand
            :mic-analyser="voice.micAnalyser"
            :speech-prob="voice.speechProb.value"
            :active="micOn"
          />
          <UAlert
            v-if="voice.error.value"
            color="error"
            class="absolute top-3 mx-3"
            :title="voice.error.value"
          />
        </div>
      </template>
    </UDashboardPanel>

    <VoiceSettingsSlideover v-model:open="settingsOpen" :voice="voice" />
  </div>
</template>
```

Add to `<script setup>`:

```ts
const settingsOpen = ref(false)
const fullBleed = ref(false)
const activeConversationId = ref<string | null>(null)
const activeTitle = ref<string | null>(null)
const isBusy = computed(() => ['thinking', 'tool', 'speaking', 'typing'].includes(voice.state.value))
```

and set `activeConversationId` / `activeTitle` inside the existing `resume(id)` (from the `getConversation` result) and clear both in a `newConversation` wrapper.

- [ ] **Step 4: Browser-validate the responsive fix**

```bash
playwright-cli goto "http://localhost:3000/agent"
playwright-cli resize 900 800
playwright-cli eval "() => { const i=document.querySelector('textarea, input[placeholder*=\"Ask\"]'); const r=i.getBoundingClientRect(); return { w:r.width, h:r.height } }"
```
Expected: non-zero width and height. This is the regression that motivated the task — at 900 px the composer previously measured `0×0` with `display:none`. Repeat at 375, 768, 1440.

- [ ] **Step 5: Commit**

```bash
git add app/pages/agent/index.vue app/components/agent/Toolbar.vue app/components/agent/ThreadRail.vue
git commit -m "feat(agent): three-column shell with a permanent thread rail and one toolbar"
```

---

## Task 7: Autoscroll with a bottom pin and a "new messages" release

**Files:**
- Modify: `app/components/voice/Transcript.vue`
- Test: `test/agent-transcript-scroll.test.ts` (create)

**Interfaces:**
- Consumes: `isAtBottom`, `countNewSince` from `app/utils/transcript-scroll.ts` (already exported; built for `/sessions` in cycle 24).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```ts
// test/agent-transcript-scroll.test.ts
import { describe, it, expect } from 'vitest'
import { isAtBottom, countNewSince } from '../app/utils/transcript-scroll'

describe('agent transcript scroll helpers', () => {
  it('reports not-at-bottom for the measured regression case', () => {
    // The live defect: a 3338px reply in an 879px box with scrollTop stuck at 0.
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 3338, clientHeight: 879 })).toBe(false)
  })

  it('reports at-bottom once pinned', () => {
    expect(isAtBottom({ scrollTop: 2459, scrollHeight: 3338, clientHeight: 879 })).toBe(true)
  })

  it('counts entries added after the last seen one', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
    expect(countNewSince(items, 'b')).toBe(2)
    expect(countNewSince(items, 'd')).toBe(0)
    expect(countNewSince(items, null)).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it passes already**

Run: `pnpm vitest run test/agent-transcript-scroll.test.ts`
Expected: PASS — the helpers exist. This test pins the contract the component now depends on; the component wiring below is what is actually missing.

- [ ] **Step 3: Wire it into the component**

In `app/components/voice/Transcript.vue`, add to `<script setup>`:

```ts
import { isAtBottom, countNewSince } from '~/utils/transcript-scroll'

const props = defineProps<{ entries: TranscriptEntry[] }>()
const emit = defineEmits<{ undo: [entry: TranscriptEntry]; retry: [entry: TranscriptEntry] }>()

const scroller = ref<HTMLElement | null>(null)
const pinned = ref(true)
const lastSeenId = ref<string | null>(null)

const newCount = computed(() => pinned.value ? 0 : countNewSince(props.entries, lastSeenId.value))

function onScroll() {
  const el = scroller.value
  if (!el) return
  pinned.value = isAtBottom(el)
  // Re-arm the counter's baseline whenever the user returns to the bottom.
  if (pinned.value) lastSeenId.value = props.entries[props.entries.length - 1]?.id ?? null
}

function scrollToBottom() {
  const el = scroller.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  pinned.value = true
  lastSeenId.value = props.entries[props.entries.length - 1]?.id ?? null
}

// Deep watch: streaming mutates the LAST entry's text in place rather than pushing a
// new one, so watching entries.length alone would never fire during a reply.
watch(() => props.entries.map(e => e.id + e.text.length).join('|'), async () => {
  if (!pinned.value) return
  await nextTick()
  scrollToBottom()
})

onMounted(() => { scrollToBottom() })
```

Wrap the existing list markup so the scroll container is referenced, and add the release chip:

```vue
<template>
  <div class="relative min-h-0">
    <div
      ref="scroller"
      class="flex flex-col gap-2 overflow-y-auto p-3 h-full"
      @scroll.passive="onScroll"
    >
      <!-- the existing v-for over entries, unchanged -->
    </div>

    <UButton
      v-if="newCount > 0"
      :label="`${newCount} new`"
      icon="i-lucide-arrow-down"
      size="xs"
      color="primary"
      class="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-lg"
      @click="scrollToBottom"
    />
  </div>
</template>
```

- [ ] **Step 4: Browser-validate against the original measurement**

```bash
playwright-cli goto "http://localhost:3000/agent"
# send a long prompt, wait for the reply to stream, then:
playwright-cli eval "() => { const el=[...document.querySelectorAll('div')].find(d=>(d.className||'').toString().includes('overflow-y-auto')&&(d.className||'').toString().includes('gap-2')); return { st: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight, pinned: el.scrollHeight-el.scrollTop-el.clientHeight <= 40 } }"
```
Expected: `pinned: true`. Before this task the same probe returned `scrollTop: 0` against `scrollHeight: 3338`. Then scroll up and confirm the "N new" chip appears and re-pins on click.

- [ ] **Step 5: Commit**

```bash
git add app/components/voice/Transcript.vue test/agent-transcript-scroll.test.ts
git commit -m "feat(agent): pin the transcript to the bottom while streaming, with a new-message release"
```

---

## Task 8: Composer — multiline, shift-enter, and Stop

**Files:**
- Modify: `app/components/voice/Composer.vue`
- Modify: `app/composables/useVoice.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `useVoice().stop(): void` — sends `{type:'interrupt'}` on the open socket.

- [ ] **Step 1: Add `stop()` to `useVoice`**

In `app/composables/useVoice.ts`, next to the existing barge-in send (line ~280 is currently the ONLY caller of the interrupt frame), add to the returned object:

```ts
  /** Abort the running turn. Same frame the VAD barge-in path sends — until now
   *  a typed turn had no way to reach it and ran to completion. */
  stop() {
    ws?.send(JSON.stringify({ type: 'interrupt' }))
    stopPlayback()
    state.value = 'idle'
  },
```

Use whatever the local playback-stop helper is named in this file (the function that bumps `playEpoch` and disconnects queued nodes); do not duplicate it.

- [ ] **Step 2: Convert the input and add Stop**

In `app/components/voice/Composer.vue`, extend props and emits:

```ts
const props = defineProps<{
  entries: TranscriptEntry[]
  sendText?: (t: string, speak?: boolean, attachments?: AttachmentRef[]) => boolean | Promise<boolean>
  speak?: boolean
  busy?: boolean
  micOn?: boolean
  initialText?: string
  autoSend?: boolean
}>()
const emit = defineEmits<{ stop: []; toggleMic: [] }>()

function onKeydown(e: KeyboardEvent) {
  // Enter sends; Shift+Enter is a newline. Without this a multiline composer
  // cannot be submitted from the keyboard at all.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
}
```

Replace the `UInput` with a `UTextarea` and swap the submit button while busy:

```vue
      <UTextarea
        v-model="text"
        :rows="1"
        :maxrows="8"
        autoresize
        placeholder="Ask Bridget anything…"
        class="flex-1"
        @paste="onPaste"
        @keydown="onKeydown"
      />

      <UButton
        :icon="micOn ? 'i-lucide-mic' : 'i-lucide-mic-off'"
        :color="micOn ? 'primary' : 'neutral'"
        :variant="micOn ? 'soft' : 'ghost'"
        type="button"
        :aria-label="micOn ? 'Disable microphone' : 'Enable microphone'"
        @click="emit('toggleMic')"
      />

      <UButton
        v-if="busy"
        type="button"
        icon="i-lucide-square"
        color="neutral"
        variant="soft"
        aria-label="Stop generating"
        @click="emit('stop')"
      />
      <UButton
        v-else
        type="submit"
        icon="i-lucide-send"
        :disabled="(!text.trim() && !pending.length) || uploading"
        :loading="uploading"
      />
```

- [ ] **Step 3: Browser-validate**

```bash
playwright-cli goto "http://localhost:3000/agent"
playwright-cli snapshot | grep -i "Ask Bridget"
```
Send a long prompt, then click Stop (real `playwright-cli click <ref>`) while it streams and confirm the reply halts and the state returns to idle. Separately, type text and press Shift+Enter — a newline is inserted rather than sending.

- [ ] **Step 4: Run the gates**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/components/voice/Composer.vue app/composables/useVoice.ts
git commit -m "feat(agent): multiline composer with shift-enter and a working stop button"
```

---

## Task 9: Message treatment and actions

**Files:**
- Create: `app/components/agent/MessageActions.vue`
- Modify: `app/components/voice/Transcript.vue`
- Modify: `app/pages/agent/index.vue` (add `retryTurn`)

**Interfaces:**
- Consumes: `TranscriptEntry` (from `useVoice`), `usage` from Task 4.
- Produces: `<AgentMessageActions :entry="TranscriptEntry" @retry="() => void" />`

- [ ] **Step 1: Write the actions component**

```vue
<!-- app/components/agent/MessageActions.vue -->
<script setup lang="ts">
import type { TranscriptEntry } from '~/composables/useVoice'

const props = defineProps<{ entry: TranscriptEntry }>()
const emit = defineEmits<{ retry: [] }>()

const toast = useToast()
const copied = ref(false)

async function copy() {
  try {
    await navigator.clipboard.writeText(props.entry.text)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch {
    toast.add({ color: 'error', title: 'Copy failed', description: 'The browser blocked clipboard access.' })
  }
}

const time = computed(() =>
  props.entry.createdAt ? new Date(props.entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')

// Absent usage renders nothing rather than a misleading zero — messages written
// before the usage column exists simply have no count.
const tokens = computed(() => {
  const t = props.entry.usage?.totalTokens
  return typeof t === 'number' && t > 0 ? (t >= 1000 ? `${(t / 1000).toFixed(1)}k tok` : `${t} tok`) : ''
})
</script>

<template>
  <div class="flex items-center gap-2 pt-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
    <UButton
      :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
      size="xs"
      variant="ghost"
      color="neutral"
      :aria-label="copied ? 'Copied' : 'Copy message'"
      @click="copy"
    />
    <UButton
      v-if="entry.role === 'assistant'"
      icon="i-lucide-refresh-cw"
      size="xs"
      variant="ghost"
      color="neutral"
      aria-label="Retry this reply"
      @click="emit('retry')"
    />
    <span v-if="time" class="text-[10px] text-dimmed tabular-nums">{{ time }}</span>
    <span v-if="tokens" class="text-[10px] text-dimmed tabular-nums">{{ tokens }}</span>
  </div>
</template>
```

- [ ] **Step 2: Extend `TranscriptEntry`**

In `app/composables/useVoice.ts`, add two optional fields to the interface (both display-only):

```ts
  createdAt?: string
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null
```

Populate them in `resume()`'s `buildResumeTranscript` mapping from the DTO, and set `createdAt` to `new Date().toISOString()` when a live entry is created.

- [ ] **Step 3: Give turns visual separation**

In `Transcript.vue`, wrap each non-tool entry in a `group` row with a role avatar, and mount the actions:

```vue
      <div v-else class="group flex gap-2.5 items-start">
        <span
          class="mt-0.5 size-6 shrink-0 rounded-full grid place-items-center text-[10px] font-semibold"
          :class="e.role === 'user'
            ? 'bg-elevated border border-default text-muted'
            : 'bg-primary/10 border border-primary/40 text-primary'"
        >{{ e.role === 'user' ? 'You'.charAt(0) : 'B' }}</span>

        <div class="min-w-0 flex-1 flex flex-col gap-1">
          <!-- the existing reasoning block / MdView / user-text branches, unchanged -->
          <AgentMessageActions :entry="e" @retry="emit('retry', e)" />
        </div>
      </div>
```

The `<MdView :cache-key="\`transcript-${e.id}\`">` stays exactly as it is. Do not change it.

- [ ] **Step 4: Implement retry on the page**

In `app/pages/agent/index.vue`:

```ts
/** Re-send the user turn that preceded this assistant entry, dropping the assistant
 *  turn and everything after it. This replaces in place — it does NOT fork; parent_id
 *  branching stays deferred. */
async function retryTurn(entry: TranscriptEntry) {
  const t = voice.transcript.value
  const i = t.findIndex(e => e.id === entry.id)
  if (i < 0) return
  let j = i - 1
  while (j >= 0 && t[j]!.role !== 'user') j--
  const userTurn = t[j]
  if (!userTurn) return
  voice.transcript.value = t.slice(0, j)
  await voice.sendText(userTurn.text, speakReply.value, userTurn.attachments)
}
```

- [ ] **Step 5: Browser-validate and commit**

Hover a reply, confirm copy / retry / timestamp appear; click retry and confirm the reply regenerates. Then:

```bash
pnpm typecheck && pnpm test
git add app/components/agent/MessageActions.vue app/components/voice/Transcript.vue app/composables/useVoice.ts app/pages/agent/index.vue
git commit -m "feat(agent): turn separation plus copy, retry, timestamp and token count per message"
```

---

## Task 10: Empty state

**Files:**
- Create: `app/components/agent/EmptyState.vue`
- Modify: `app/components/voice/Transcript.vue`

**Interfaces:**
- Consumes: nothing.
- Produces: `<AgentEmptyState @pick="(prompt: string) => void" />`

- [ ] **Step 1: Write the component**

```vue
<!-- app/components/agent/EmptyState.vue -->
<script setup lang="ts">
const emit = defineEmits<{ pick: [prompt: string] }>()

// Drawn from the real tool surface — the page previously gave no indication that
// 20 tools, skills and subagents sit behind it.
const starters = [
  { icon: 'i-lucide-brain', label: 'What did we work on yesterday?' },
  { icon: 'i-lucide-list-checks', label: 'What are my open tasks?' },
  { icon: 'i-lucide-globe', label: 'Research the latest on self-hosted TTS' },
  { icon: 'i-lucide-terminal', label: 'Check disk usage on the app box' }
]
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-5 px-6 py-16 text-center">
    <div class="flex flex-col gap-1.5">
      <h2 class="text-lg font-semibold text-highlighted">Bridget</h2>
      <p class="max-w-md text-sm text-muted">
        She can search your memories, documents, projects and tasks, research the web,
        generate images, and run commands on the box — and she'll ask before anything destructive.
      </p>
    </div>
    <div class="grid gap-2 sm:grid-cols-2 w-full max-w-lg">
      <UButton
        v-for="s in starters"
        :key="s.label"
        :icon="s.icon"
        :label="s.label"
        color="neutral"
        variant="outline"
        size="sm"
        class="justify-start text-left"
        @click="emit('pick', s.label)"
      />
    </div>
  </div>
</template>
```

- [ ] **Step 2: Mount it**

In `Transcript.vue`, inside the scroll container, before the `v-for`:

```vue
      <AgentEmptyState
        v-if="!entries.length"
        @pick="(p) => emit('pick', p)"
      />
```

Add `pick: [prompt: string]` to the emits, forward it from the page into the composer's `text` ref (add a `prefill` prop on `Composer.vue` that sets `text.value` on change without auto-sending).

- [ ] **Step 3: Browser-validate**

Open `/agent`, click New, confirm the empty state renders with four starters, click one and confirm it lands in the composer without sending.

- [ ] **Step 4: Run the gates**

Run: `pnpm typecheck && pnpm test`

- [ ] **Step 5: Commit**

```bash
git add app/components/agent/EmptyState.vue app/components/voice/Transcript.vue app/components/voice/Composer.vue app/pages/agent/index.vue
git commit -m "feat(agent): a real empty state naming Bridget and what she can reach"
```

---

## Task 11: Microphone device picker

**Files:**
- Modify: `app/composables/useVoiceSettings.ts`
- Modify: `app/composables/useVoice.ts:264`
- Modify: `app/components/voice/SettingsSlideover.vue`

**Interfaces:**
- Consumes: nothing.
- Produces: `useVoiceSettings().settings.micDeviceId: string`  (`''` = system default)

- [ ] **Step 1: Add the setting**

In `app/composables/useVoiceSettings.ts`, add `micDeviceId: ''` to the defaults object and its type.

- [ ] **Step 2: Apply the constraint**

In `app/composables/useVoice.ts`, at the `getUserMedia` call (currently line 264):

```ts
        const deviceId = settings.value.micDeviceId
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
            // '' means "let the OS choose". An explicit id is `exact` so a stale
            // selection fails loudly here rather than silently using the wrong mic.
            ...(deviceId ? { deviceId: { exact: deviceId } } : {})
          }
        })
```

Wrap the acquisition so a vanished device degrades instead of breaking the mic:

```ts
        // A device that has been unplugged since it was chosen throws
        // OverconstrainedError. Fall back to the default rather than leaving the
        // user with a dead microphone and no explanation.
        .catch(async (err: Error) => {
          if (err.name !== 'OverconstrainedError') throw err
          settings.value = { ...settings.value, micDeviceId: '' }
          error.value = 'That microphone is no longer available — switched to the system default.'
          return navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
          })
        })
```

- [ ] **Step 3: Add the picker UI**

In `app/components/voice/SettingsSlideover.vue`, beside the voice picker:

```ts
const DEFAULT_MIC = '__default__'
const mics = ref<{ label: string; value: string }[]>([{ label: 'System default', value: DEFAULT_MIC }])

async function loadMics() {
  if (!navigator.mediaDevices?.enumerateDevices) return
  const devices = await navigator.mediaDevices.enumerateDevices()
  const inputs = devices.filter(d => d.kind === 'audioinput')
  mics.value = [
    { label: 'System default', value: DEFAULT_MIC },
    // Labels are EMPTY until mic permission has been granted at least once — a browser
    // privacy rule, not a bug. Fall back to a positional name so the list is still usable.
    ...inputs.map((d, i) => ({ label: d.label || `Microphone ${i + 1}`, value: d.deviceId }))
  ]
}

// reka-ui's USelectMenu rejects an empty-string item value, so '' round-trips
// through a non-empty sentinel.
const selectedMic = computed({
  get: () => settings.value.micDeviceId || DEFAULT_MIC,
  set: (v: string) => { settings.value = { ...settings.value, micDeviceId: v === DEFAULT_MIC ? '' : v } }
})

onMounted(() => {
  void loadMics()
  navigator.mediaDevices?.addEventListener?.('devicechange', loadMics)
})
onBeforeUnmount(() => {
  navigator.mediaDevices?.removeEventListener?.('devicechange', loadMics)
})
```

```vue
    <UFormField label="Microphone" description="Applies the next time the mic is enabled.">
      <USelectMenu
        v-model="selectedMic"
        :items="mics"
        value-key="value"
        class="w-full"
      />
    </UFormField>
```

- [ ] **Step 4: Browser-validate**

Open the settings slideover, confirm the microphone list renders with at least "System default". Grant mic permission once, reopen, and confirm real device labels replace the positional names.

- [ ] **Step 5: Commit**

```bash
git add app/composables/useVoiceSettings.ts app/composables/useVoice.ts app/components/voice/SettingsSlideover.vue
git commit -m "feat(voice): microphone device picker persisted with the other voice settings"
```

---

## Task 12: The mic band

**Files:**
- Create: `app/components/agent/MicBand.vue`
- Delete: `app/lib/viz/ring.ts` and its references in `app/lib/viz/scene.ts` / the reactor

**Interfaces:**
- Consumes: `AnalyserNode` (`micAnalyser`, `fftSize: 256` → 128 bins), `speechProb` ref, `positiveSpeechThreshold` from `useVoiceSettings`.
- Produces: `<AgentMicBand :mic-analyser="AnalyserNode | null" :speech-prob="number" :active="boolean" />`

**Two signals, not one.** The FFT bars are amplitude; the VAD triggers on Silero's per-frame *probability*. They are different units, so a single threshold line drawn across the bars would be meaningless. The band shows bars for what is coming in, plus a thin probability track with the threshold marked.

- [ ] **Step 1: Write the component**

```vue
<!-- app/components/agent/MicBand.vue -->
<script setup lang="ts">
const props = defineProps<{
  micAnalyser: AnalyserNode | null
  speechProb: number
  active: boolean
}>()

const { settings } = useVoiceSettings()
const canvas = ref<HTMLCanvasElement | null>(null)
let raf = 0

const BARS = 56

function draw() {
  const cv = canvas.value
  const ctx = cv?.getContext('2d')
  if (!cv || !ctx) { raf = requestAnimationFrame(draw); return }

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = cv.clientWidth * dpr
  const h = cv.clientHeight * dpr
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h }

  ctx.clearRect(0, 0, w, h)

  const trackH = Math.max(3 * dpr, h * 0.12)
  const barsH = h - trackH - 2 * dpr

  // ── FFT bars: what the microphone is actually picking up ──
  const speaking = props.active && props.speechProb >= settings.value.positiveSpeechThreshold
  if (props.micAnalyser) {
    const bins = new Uint8Array(props.micAnalyser.frequencyBinCount)
    props.micAnalyser.getByteFrequencyData(bins)
    const bw = w / BARS
    for (let i = 0; i < BARS; i++) {
      // Log-spaced: voice energy sits low, so a linear map wastes most of the width.
      const t = i / (BARS - 1)
      const bin = Math.min(bins.length - 1, Math.round(Math.pow(t, 2) * (bins.length - 1)))
      const v = (bins[bin] ?? 0) / 255
      const bh = Math.max(1 * dpr, v * barsH)
      ctx.fillStyle = speaking ? 'rgba(56, 189, 208, 0.95)' : 'rgba(120, 140, 168, 0.45)'
      ctx.fillRect(i * bw + bw * 0.2, barsH - bh, bw * 0.6, bh)
    }
  }

  // ── Speech-probability track, with the VAD threshold marked. A DIFFERENT unit
  //    from the bars above: this is Silero's per-frame probability, which is what
  //    actually decides whether a turn fires. ──
  const y = h - trackH
  ctx.fillStyle = 'rgba(120, 140, 168, 0.18)'
  ctx.fillRect(0, y, w, trackH)
  ctx.fillStyle = speaking ? 'rgba(56, 189, 208, 0.9)' : 'rgba(150, 170, 195, 0.55)'
  ctx.fillRect(0, y, w * Math.min(1, Math.max(0, props.speechProb)), trackH)

  const tx = w * settings.value.positiveSpeechThreshold
  ctx.fillStyle = 'rgba(232, 163, 61, 0.9)'
  ctx.fillRect(tx - dpr, y - 2 * dpr, 2 * dpr, trackH + 4 * dpr)

  raf = requestAnimationFrame(draw)
}

onMounted(() => { raf = requestAnimationFrame(draw) })
onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<template>
  <div class="relative h-14 shrink-0 border-t border-default/40 bg-black">
    <canvas ref="canvas" class="block h-full w-full" />
    <span class="pointer-events-none absolute left-2 top-1 font-mono text-[9px] uppercase tracking-wider"
          :class="active ? 'text-primary/80' : 'text-muted/60'">
      {{ active ? 'listening' : 'mic off' }}
    </span>
  </div>
</template>
```

- [ ] **Step 2: Retire the ring**

```bash
rm app/lib/viz/ring.ts
```

Remove its import, construction, per-frame update and dispose call from wherever the scene assembles it (`app/lib/viz/scene.ts` and/or `app/components/voice/Reactor.client.vue`). Run `pnpm typecheck` — it will name every remaining reference.

- [ ] **Step 3: Validate**

Run: `pnpm typecheck && pnpm build`
Expected: PASS with no dangling `ring` imports. In the browser, enable the mic and confirm the bars respond to speech and the amber threshold marker sits at the configured position.

- [ ] **Step 4: Commit**

```bash
git add -A app/components/agent/MicBand.vue app/lib/viz app/components/voice
git commit -m "feat(agent): mic band with FFT bars and a VAD probability track; retire the 96-bar ring"
```

---

## Task 13: The `Avatar` interface and choreography

**Files:**
- Create: `app/lib/avatar/types.ts`
- Create: `app/lib/avatar/choreography.ts`
- Test: `app/lib/avatar/choreography.test.ts`

**Interfaces:**
- Consumes: `VizState`, `VizEvent` from `app/lib/viz/types.ts`.
- Produces:
  - `export interface Avatar { setState, pushEvent, setAnalysers, resize, dispose }`
  - `export interface Pose { yaw: number; pitch: number; jaw: number; brow: number; eyeGain: number; assemble: number; scan: number }`
  - `export function createChoreographer(rng?: () => number): { step(state: VizState, dt: number, outLevel: number): Pose }`

**Sign convention, load-bearing:** **positive pitch is looking UP.** The brainstorm sketch had this inverted, which is why "thinking" appeared to stare at the floor. The test below pins it.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/avatar/choreography.test.ts
import { describe, it, expect } from 'vitest'
import { createChoreographer } from './choreography'

/** Deterministic RNG so scheduled events are assertable. */
function seeded(seed = 1) {
  let s = seed
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296 }
}

function run(state: Parameters<ReturnType<typeof createChoreographer>['step']>[0], frames: number, out = 0) {
  const c = createChoreographer(seeded())
  const poses = []
  for (let i = 0; i < frames; i++) poses.push({ ...c.step(state, 1 / 60, out) })
  return poses
}

describe('choreography', () => {
  it('thinking looks UP — positive pitch', () => {
    const poses = run('thinking', 240)
    const settled = poses.slice(120)
    expect(Math.max(...settled.map(p => p.pitch))).toBeGreaterThan(0.1)
    expect(settled.every(p => p.pitch > -0.05)).toBe(true)
  })

  it('thinking saccades — the gaze holds, then jumps, and does not sweep smoothly', () => {
    const yaws = run('thinking', 600).map(p => p.yaw)
    const deltas = yaws.slice(1).map((y, i) => Math.abs(y - yaws[i]!))
    const big = deltas.filter(d => d > 0.004).length
    // A smooth sine sweep moves on nearly every frame; saccades move on a minority.
    expect(big).toBeGreaterThan(5)
    expect(big).toBeLessThan(yaws.length * 0.5)
  })

  it('listening turns toward the viewer and holds', () => {
    const poses = run('listening', 300).slice(150)
    expect(Math.min(...poses.map(p => p.yaw))).toBeGreaterThan(0.1)
  })

  it('listening nods DOWN — negative pitch excursions', () => {
    const poses = run('listening', 900)
    expect(Math.min(...poses.map(p => p.pitch))).toBeLessThan(-0.03)
  })

  it('speaking drives the jaw from the output level and rests between phrases', () => {
    const poses = run('speaking', 600, 0.8)
    const jaws = poses.map(p => p.jaw)
    expect(Math.max(...jaws)).toBeGreaterThan(0.3)
    expect(Math.min(...jaws)).toBeLessThan(0.05)
  })

  it('speaking does not repeat: two different seeds diverge', () => {
    const a = createChoreographer(seeded(1))
    const b = createChoreographer(seeded(99))
    const ja: number[] = []; const jb: number[] = []
    for (let i = 0; i < 400; i++) { ja.push(a.step('speaking', 1 / 60, 0.8).jaw); jb.push(b.step('speaking', 1 / 60, 0.8).jaw) }
    expect(ja.join(',')).not.toBe(jb.join(','))
  })

  it('is deterministic for a given seed', () => {
    const one = run('thinking', 200).map(p => p.yaw.toFixed(4)).join(',')
    const two = run('thinking', 200).map(p => p.yaw.toFixed(4)).join(',')
    expect(one).toBe(two)
  })

  it('connecting ramps assemble from 0 toward 1', () => {
    const poses = run('connecting', 300)
    expect(poses[0]!.assemble).toBeLessThan(0.1)
    expect(poses[poses.length - 1]!.assemble).toBeGreaterThan(0.9)
  })

  it('idle keeps the head near neutral', () => {
    const poses = run('idle', 600)
    expect(Math.max(...poses.map(p => Math.abs(p.yaw)))).toBeLessThan(0.15)
  })

  it('tool sweeps a scan value across the face', () => {
    const scans = run('tool', 300).map(p => p.scan)
    expect(Math.max(...scans)).toBeGreaterThan(0.5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run app/lib/avatar/choreography.test.ts`
Expected: FAIL — `Failed to resolve import "./choreography"`.

- [ ] **Step 3: Write the interface and the choreographer**

```ts
// app/lib/avatar/types.ts
import type { VizState, VizEvent } from '../viz/types'

/**
 * State in, pixels out. The renderer sits behind this so a rigged-mesh
 * implementation can replace ParticleHead later without touching the
 * orchestrator or useVoice. The cycle-19 boundary still holds: useVoice never
 * imports Three.js, and nothing under lib/avatar touches the WebSocket.
 */
export interface Avatar {
  setState(s: VizState): void
  pushEvent(e: VizEvent): void
  setAnalysers(mic: AnalyserNode | null, out: AnalyserNode | null): void
  resize(w: number, h: number): void
  dispose(): void
}

export interface Pose {
  /** Radians. Positive = turned toward the viewer's right. */
  yaw: number
  /** Radians. POSITIVE = LOOKING UP. Inverting this is what made "thinking" stare down. */
  pitch: number
  /** 0..1, drives the baked jawW displacement. */
  jaw: number
  /** 0..1, brow lift on stressed syllables. */
  brow: number
  /** Multiplier on eye-region brightness. */
  eyeGain: number
  /** 0..1 assembly progress for the connecting intro. */
  assemble: number
  /** 0..1 vertical position of the amber tool scan; 0 = inactive. */
  scan: number
}
```

```ts
// app/lib/avatar/choreography.ts
// Pure pose state machine. EVERY motion is event-scheduled against an injected RNG —
// nothing is a periodic function. The first sketch used summed sines throughout and
// read as an obvious loop, which is the specific thing this file exists to avoid.
import type { VizState } from '../viz/types'
import type { Pose } from './types'

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export function createChoreographer(rng: () => number = Math.random) {
  const rand = (a: number, b: number) => a + rng() * (b - a)

  let yaw = 0, pitch = 0, jaw = 0, brow = 0, assemble = 0, scan = 0
  let t = 0

  // thinking: saccade targets held for a random interval
  let gazeYaw = 0, gazePitch = 0.24, gazeHold = 0
  // listening: nods at random intervals, sometimes doubled
  let nodTimer = rand(1.0, 2.6), nodPhase = 0, nodDepth = 0.11, nodDouble = false
  // idle: micro-saccades
  let idleYaw = 0, idleTimer = rand(1.2, 3.5)
  // speaking: syllables grouped into phrases with pauses
  let sylLeft = 0, sylLen = 0, sylPeak = 0, gapLeft = 0
  let phraseLeft = Math.round(rand(5, 12)), pauseLeft = 0, phraseNudge = 0

  /** Syllable-and-phrase envelope. Scaled by the live TTS output level so a quiet
   *  passage does not drive a wide-open jaw. */
  function speechEnvelope(dt: number, outLevel: number): number {
    let target: number
    if (pauseLeft > 0) { pauseLeft -= dt; target = 0 }
    else if (gapLeft > 0) { gapLeft -= dt; target = 0.04 }
    else if (sylLeft > 0) {
      const p = 1 - sylLeft / sylLen
      const env = p < 0.28 ? p / 0.28 : 1 - (p - 0.28) / 0.72
      target = sylPeak * Math.max(0, env)
      sylLeft -= dt
    } else {
      sylLen = sylLeft = rand(0.10, 0.25)
      sylPeak = rand(0.32, 1)
      gapLeft = rand(0.02, 0.12)
      if (--phraseLeft <= 0) {
        pauseLeft = rand(0.30, 0.78)
        phraseLeft = Math.round(rand(5, 12))
        phraseNudge = rand(-1, 1)
      }
      target = 0
    }
    return target * Math.max(0.25, Math.min(1, outLevel || 0.75))
  }

  function step(state: VizState, dt: number, outLevel = 0): Pose {
    t += dt
    assemble = state === 'connecting'
      ? Math.min(1, assemble + dt * 0.55)
      : Math.min(1, assemble + dt * 1.2)

    let tYaw = 0, tPitch = 0, ease = 3.0
    let eyeGain = 1

    if (state === 'idle') {
      if ((idleTimer -= dt) <= 0) { idleYaw = rand(-0.07, 0.07); idleTimer = rand(1.2, 3.6) }
      tYaw = idleYaw
      tPitch = 0
    }
    else if (state === 'listening') {
      if ((nodTimer -= dt) <= 0) {
        nodPhase = 1; nodDepth = rand(0.08, 0.16)
        nodDouble = rng() < 0.34
        nodTimer = rand(1.6, 3.8)
      }
      if (nodPhase > 0) nodPhase = Math.max(0, nodPhase - dt * 1.6)
      // NEGATIVE pitch = chin down = a nod.
      tPitch = nodPhase > 0 ? -Math.sin((1 - nodPhase) * Math.PI * (nodDouble ? 2 : 1)) * nodDepth : 0
      tYaw = 0.24
      ease = 5.0
      eyeGain = 2.0
    }
    else if (state === 'thinking') {
      if ((gazeHold -= dt) <= 0) {
        gazeYaw = rand(-0.34, 0.34)
        gazePitch = rand(0.18, 0.34)      // POSITIVE = looking up
        gazeHold = rand(0.5, 2.0)
      }
      tYaw = gazeYaw; tPitch = gazePitch
      ease = 7.0                           // saccades snap
      eyeGain = 1.5
    }
    else if (state === 'speaking') {
      const target = speechEnvelope(dt, outLevel)
      jaw = lerp(jaw, target, Math.min(1, dt * 18))
      brow = lerp(brow, jaw > 0.55 ? 1 : 0, Math.min(1, dt * 8))
      tYaw = phraseNudge * 0.05
      tPitch = -jaw * 0.03
      ease = 4.5
    }
    else if (state === 'tool') {
      scan = (scan + dt * 0.55) % 1.35
    }

    if (state !== 'speaking') {
      jaw = lerp(jaw, 0, Math.min(1, dt * 10))
      brow = lerp(brow, 0, Math.min(1, dt * 6))
    }
    if (state !== 'tool') scan = 0

    yaw = lerp(yaw, tYaw, Math.min(1, dt * ease))
    pitch = lerp(pitch, tPitch, Math.min(1, dt * ease))

    return { yaw, pitch, jaw, brow, eyeGain, assemble, scan }
  }

  return { step }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run app/lib/avatar/choreography.test.ts`
Expected: PASS, 10 tests. The pitch-sign test is the one that must never be "fixed" by changing the assertion.

- [ ] **Step 5: Commit**

```bash
git add app/lib/avatar/
git commit -m "feat(avatar): Avatar interface plus a seeded, event-scheduled choreographer"
```

---

## Task 14: Bake the head mesh to a point buffer

**Files:**
- Create: `scripts/bake-head.ts`
- Test: `test/bake-head.test.ts` (create — tests the pure weight functions)
- Create (input, human step): `assets/source/bridget-head.glb`
- Create (output, committed): `app/assets/head-points.bin`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function jawWeight(y: number, x: number, m: HeadMetrics): number`
  - `export function regionWeights(p: {x:number;y:number;z:number}, m: HeadMetrics): { jaw: number; eye: number; brow: number }`
  - `HeadMetrics = { lipY: number; chinY: number; eyeY: number; browY: number; hingeInner: number; hingeOuter: number; faceHalfWidth: number }`

**Human prerequisite:** a female head exported from an **official, unmodified** MakeHuman build, saved to `assets/source/bridget-head.glb`. MakeHuman's exports are CC0 (public domain, commercial use, redistribution, no attribution) — this is why it was chosen over FLAME and the Basel Face Model, both of which are research-licence only. Record the provenance in the handover. **If the export does not exist yet, do Steps 1–4 (the pure functions and their tests) and stop; Step 5 is blocked, not failed.**

- [ ] **Step 1: Write the failing test**

```ts
// test/bake-head.test.ts
import { describe, it, expect } from 'vitest'
import { jawWeight, regionWeights, type HeadMetrics } from '../scripts/bake-head'

const M: HeadMetrics = {
  lipY: 0.0, chinY: -1.0, eyeY: 0.8, browY: 1.0,
  hingeInner: 0.3, hingeOuter: 0.9, faceHalfWidth: 1.0
}

describe('jawWeight', () => {
  it('is zero at and above the upper lip', () => {
    expect(jawWeight(M.lipY, 0, M)).toBe(0)
    expect(jawWeight(0.5, 0, M)).toBe(0)
  })

  it('is full at the chin', () => {
    expect(jawWeight(M.chinY, 0, M)).toBeCloseTo(1, 5)
  })

  it('increases monotonically from lip to chin', () => {
    const ys = [0.0, -0.2, -0.4, -0.6, -0.8, -1.0]
    const ws = ys.map(y => jawWeight(y, 0, M))
    for (let i = 1; i < ws.length; i++) expect(ws[i]!).toBeGreaterThanOrEqual(ws[i - 1]!)
  })

  it('moves the lower lip only a fraction of the chin travel', () => {
    // The whole point: a binary region translated as a block CLEAVES the head at the
    // lip line. The lower lip must trail the chin, not match it.
    const lowerLip = jawWeight(-0.15, 0, M)
    const chin = jawWeight(M.chinY, 0, M)
    expect(lowerLip).toBeGreaterThan(0)
    expect(lowerLip).toBeLessThan(chin * 0.45)
  })

  it('is reduced near the hinge so the jaw arcs', () => {
    const centre = jawWeight(M.chinY, 0, M)
    const hinge = jawWeight(M.chinY, 0.95, M)
    expect(hinge).toBeLessThan(centre)
    expect(hinge).toBeGreaterThan(0)
  })

  it('never exceeds 1 or drops below 0', () => {
    for (const y of [2, 1, 0, -1, -2]) {
      for (const x of [-2, -1, 0, 1, 2]) {
        const w = jawWeight(y, x, M)
        expect(w).toBeGreaterThanOrEqual(0)
        expect(w).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('regionWeights', () => {
  it('flags the eye band away from the midline', () => {
    expect(regionWeights({ x: 0.45, y: M.eyeY, z: 0.5 }, M).eye).toBeGreaterThan(0.5)
    expect(regionWeights({ x: 0.02, y: M.eyeY, z: 0.5 }, M).eye).toBeLessThan(0.5)
  })

  it('flags the brow band above the eyes', () => {
    expect(regionWeights({ x: 0.45, y: M.browY, z: 0.5 }, M).brow).toBeGreaterThan(0.5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/bake-head.test.ts`
Expected: FAIL — `Failed to resolve import "../scripts/bake-head"`.

- [ ] **Step 3: Write the script**

```ts
// scripts/bake-head.ts
// Build-time only. Reads a MakeHuman export, area-weighted-samples points across the
// surface, computes per-point region weights, and writes a packed Float32Array.
// The browser NEVER loads a mesh or a GLTF loader — only the resulting buffer.
//
// Layout per point (8 floats): x, y, z, nx, ny, nz, jawW, eyeW  (browW packed into
// the sign of eyeW is NOT done — see PACK below; brow rides a 9th float).
import { readFileSync, writeFileSync } from 'node:fs'
import { NodeIO } from '@gltf-transform/core'

export interface HeadMetrics {
  lipY: number
  chinY: number
  eyeY: number
  browY: number
  hingeInner: number
  hingeOuter: number
  faceHalfWidth: number
}

export const FLOATS_PER_POINT = 9

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Smooth jaw weight. Zero at the upper lip, full at the chin, reduced toward the
 * hinge so the jaw ARCS. A binary region translated as a block visibly cleaves the
 * head at the lip line — that was the defect the brainstorm sketch exposed.
 * The ** 0.6 curve lifts the low end so the lower lip trails the chin (~25%)
 * instead of barely moving, which is what makes the mouth read as opening.
 */
export function jawWeight(y: number, x: number, m: HeadMetrics): number {
  const vert = Math.pow(smoothstep(m.lipY, m.chinY, y), 0.6)
  const hinge = 1 - 0.6 * smoothstep(m.hingeInner, m.hingeOuter, Math.abs(x))
  return Math.max(0, Math.min(1, vert * hinge))
}

export function regionWeights(
  p: { x: number; y: number; z: number },
  m: HeadMetrics
): { jaw: number; eye: number; brow: number } {
  const band = (centre: number, halfHeight: number) => 1 - smoothstep(0, halfHeight, Math.abs(p.y - centre))
  // Away from the midline (the nose bridge is not an eye) and inside the face width.
  const lateral = smoothstep(0.10, 0.28, Math.abs(p.x)) * (1 - smoothstep(m.faceHalfWidth * 0.75, m.faceHalfWidth, Math.abs(p.x)))
  return {
    jaw: jawWeight(p.y, p.x, m),
    eye: band(m.eyeY, 0.12) * lateral,
    brow: band(m.browY, 0.09) * lateral
  }
}

/** Area-weighted surface sampling: pick a triangle proportional to its area, then a
 *  uniform barycentric point inside it. Uniform-by-vertex would clump on dense regions. */
function sampleSurface(
  positions: Float32Array,
  indices: Uint32Array,
  count: number,
  rng: () => number
): { x: number; y: number; z: number }[] {
  const triCount = indices.length / 3
  const cumulative = new Float64Array(triCount)
  let total = 0
  for (let t = 0; t < triCount; t++) {
    const [i0, i1, i2] = [indices[t * 3]!, indices[t * 3 + 1]!, indices[t * 3 + 2]!]
    const ax = positions[i1 * 3]! - positions[i0 * 3]!
    const ay = positions[i1 * 3 + 1]! - positions[i0 * 3 + 1]!
    const az = positions[i1 * 3 + 2]! - positions[i0 * 3 + 2]!
    const bx = positions[i2 * 3]! - positions[i0 * 3]!
    const by = positions[i2 * 3 + 1]! - positions[i0 * 3 + 1]!
    const bz = positions[i2 * 3 + 2]! - positions[i0 * 3 + 2]!
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx
    total += 0.5 * Math.hypot(cx, cy, cz)
    cumulative[t] = total
  }

  const out: { x: number; y: number; z: number }[] = []
  for (let n = 0; n < count; n++) {
    const target = rng() * total
    let lo = 0, hi = triCount - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid]! < target) lo = mid + 1; else hi = mid }
    const [i0, i1, i2] = [indices[lo * 3]!, indices[lo * 3 + 1]!, indices[lo * 3 + 2]!]
    let u = rng(), v = rng()
    if (u + v > 1) { u = 1 - u; v = 1 - v }
    const w = 1 - u - v
    out.push({
      x: positions[i0 * 3]! * w + positions[i1 * 3]! * u + positions[i2 * 3]! * v,
      y: positions[i0 * 3 + 1]! * w + positions[i1 * 3 + 1]! * u + positions[i2 * 3 + 1]! * v,
      z: positions[i0 * 3 + 2]! * w + positions[i1 * 3 + 2]! * u + positions[i2 * 3 + 2]! * v
    })
  }
  return out
}

async function main() {
  const src = process.argv[2] ?? 'assets/source/bridget-head.glb'
  const dst = process.argv[3] ?? 'app/assets/head-points.bin'
  const COUNT = 50_000   // matches the existing desktop quality tier

  const io = new NodeIO()
  const doc = await io.read(src)
  const prim = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!
  const positions = prim.getAttribute('POSITION')!.getArray() as Float32Array
  const indices = Uint32Array.from(prim.getIndices()!.getArray()!)

  // Normalize into head-local space: origin between the eyes, unit ~= head half-width.
  let minY = Infinity, maxY = -Infinity, maxX = 0
  for (let i = 0; i < positions.length; i += 3) {
    minY = Math.min(minY, positions[i + 1]!); maxY = Math.max(maxY, positions[i + 1]!)
    maxX = Math.max(maxX, Math.abs(positions[i]!))
  }
  const scale = 1 / maxX
  const midY = (minY + maxY) / 2

  // Proportions as fractions of the normalized head. Tune by eye against the render
  // and re-run — the bake is cheap.
  const m: HeadMetrics = {
    browY: 0.30, eyeY: 0.16, lipY: -0.42, chinY: -0.95,
    hingeInner: 0.30, hingeOuter: 0.90, faceHalfWidth: 1.0
  }

  let seed = 12345
  const rng = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }

  const pts = sampleSurface(positions, indices, COUNT, rng)
  const buf = new Float32Array(COUNT * FLOATS_PER_POINT)

  pts.forEach((raw, i) => {
    const p = { x: raw.x * scale, y: (raw.y - midY) * scale, z: raw.z * scale }
    const w = regionWeights(p, m)
    const o = i * FLOATS_PER_POINT
    buf[o] = p.x; buf[o + 1] = p.y; buf[o + 2] = p.z
    buf[o + 3] = 0; buf[o + 4] = 0; buf[o + 5] = 1   // normals filled by the renderer if needed
    buf[o + 6] = w.jaw; buf[o + 7] = w.eye; buf[o + 8] = w.brow
  })

  writeFileSync(dst, Buffer.from(buf.buffer))
  console.log(`baked ${COUNT} points -> ${dst} (${(buf.byteLength / 1024 / 1024).toFixed(2)} MB)`)
}

// Only run when invoked directly, so the pure functions above stay importable by tests.
if (process.argv[1]?.endsWith('bake-head.ts')) void main()
```

Add the dependency and a script:

```bash
pnpm add -D @gltf-transform/core
```

In `package.json` scripts: `"bake:head": "tsx scripts/bake-head.ts"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/bake-head.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Bake (BLOCKED until the export exists)**

```bash
pnpm bake:head
ls -la app/assets/head-points.bin
```
Expected: a ~1.7 MB file. If `assets/source/bridget-head.glb` is absent, stop here and report the task as blocked on the MakeHuman export — do not fabricate a mesh.

- [ ] **Step 6: Commit**

```bash
git add scripts/bake-head.ts test/bake-head.test.ts package.json pnpm-lock.yaml
# add the .bin and the source export only once they exist
git commit -m "feat(avatar): bake a MakeHuman head to a point buffer with smooth jaw weights"
```

---

## Task 15: `ParticleHead` — the renderer

**Files:**
- Create: `app/lib/avatar/particle-head.ts`
- Create: `app/components/agent/Avatar.client.vue`
- Modify: `app/lib/viz/core.ts` (accept a supplied position buffer + the new attributes)
- Delete: `app/components/voice/Reactor.client.vue` (superseded)

**Interfaces:**
- Consumes: `Avatar`, `Pose` (Task 13), `head-points.bin` (Task 14), the existing `scene.ts` / `effects.ts` / `lightning.ts` / `tuning.ts`.
- Produces: `export function createParticleHead(canvas: HTMLCanvasElement): Promise<Avatar>`

- [ ] **Step 1: Load the buffer and drive the geometry**

`createParticleHead` fetches `head-points.bin`, splits the interleaved `FLOATS_PER_POINT = 9` stride into a `position` attribute (`x,y,z`) plus `jawW`, `eyeW`, `browW` attributes on the existing `BufferGeometry`, and keeps every existing piece of `scene.ts` (renderer, `EffectComposer`, `UnrealBloomPass`, quality tiers, `degrade()`).

Keep the existing tier behaviour: bake at 50k, and use the existing `setDrawRange` path for the 25k and 10k tiers rather than baking three files.

- [ ] **Step 2: Apply pose in the vertex shader**

Add uniforms `uJaw`, `uBrow`, `uYaw`, `uPitch`, `uAssemble`, `uScan`, `uEyeGain` and, in the vertex shader, before the existing motion:

```glsl
// Jaw: displace DOWN in head-local space, weighted. A binary region translated as a
// block cleaves the head at the lip line — jawW is a smooth ramp for exactly this reason.
vec3 p = position;
p.y -= uJaw * JAW_TRAVEL * aJawW;
p.y += uBrow * BROW_LIFT * aBrowW;

// Yaw about the vertical axis, then pitch about a pivot BEHIND and BELOW the face
// (near the base of the skull). Rotating about the mesh origin translates the face up
// the screen instead of rotating it. POSITIVE uPitch = looking UP.
float cy = cos(uYaw), sy = sin(uYaw);
p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);

vec3 pivot = vec3(0.0, PIVOT_Y, PIVOT_Z);   // PIVOT_Y < 0, PIVOT_Z < 0
vec3 q = p - pivot;
float cp = cos(uPitch), sp = sin(uPitch);
q = vec3(q.x, q.y * cp - q.z * sp, q.y * sp + q.z * cp);
p = q + pivot;
```

- [ ] **Step 3: Write the mount component**

`Avatar.client.vue` mirrors what `Reactor.client.vue` did — RAF loop, FFT sampling for the output level, FPS watchdog, `visibilitychange` pause, WebGL context-loss rebuild, CSS fallback when init fails, full dispose on unmount. It calls `createChoreographer()` once and feeds `step(state, dt, outLevel)` into the head's uniforms each frame.

Then delete the old reactor:

```bash
rm app/components/voice/Reactor.client.vue
```

`pnpm typecheck` will name every remaining reference to fix.

- [ ] **Step 4: Validate**

Run: `pnpm typecheck && pnpm build`
In the browser: reload `/agent` and confirm the assembly intro plays once, then click through states (enable the mic for `listening`, send a prompt for `thinking` → `tool` → `speaking`) and confirm each reads. Watch for a full 30 s that the motion does not visibly loop.

- [ ] **Step 5: Commit**

```bash
git add -A app/lib/avatar app/lib/viz app/components/agent/Avatar.client.vue app/components/voice
git commit -m "feat(avatar): ParticleHead renderer with smooth-weight jaw and pivoted pitch"
```

---

## Task 16: Full-bleed voice mode

**Files:**
- Modify: `app/pages/agent/index.vue`

**Interfaces:**
- Consumes: `AgentAvatar`, `AgentMicBand`, `fullBleed` ref (Task 6).
- Produces: nothing.

- [ ] **Step 1: Add the overlay**

```vue
    <!-- Full-bleed voice mode: her, the band, and the current line. The caption goes
         through MdView — the old page interpolated raw model text here, which is why
         the most prominent text on the page displayed literal `#` and `**`. -->
    <div
      v-if="fullBleed"
      class="fixed inset-0 z-50 flex flex-col bg-black"
      role="dialog"
      aria-label="Voice mode"
      @keydown.esc="fullBleed = false"
    >
      <UButton
        icon="i-lucide-minimize-2"
        variant="ghost"
        color="neutral"
        class="absolute right-4 top-4 z-10"
        aria-label="Back to chat"
        @click="fullBleed = false"
      />
      <AgentAvatar
        class="flex-1 min-h-0"
        :state="voice.state.value"
        :connected="voice.connected.value"
        :mic-analyser="voice.micAnalyser"
        :out-analyser="voice.outAnalyser"
        :on-viz-event="voice.onVizEvent"
      />
      <div
        v-if="caption"
        class="mx-auto mb-4 max-w-2xl px-6 text-center"
      >
        <MdView
          :source="caption.text"
          :cache-key="`caption-${caption.id}`"
          class="text-sm text-highlighted"
        />
      </div>
      <AgentMicBand
        :mic-analyser="voice.micAnalyser"
        :speech-prob="voice.speechProb.value"
        :active="micOn"
      />
    </div>
```

Keep the existing `caption` computed. Add a global escape handler so the key works without focus:

```ts
onMounted(() => {
  const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') fullBleed.value = false }
  window.addEventListener('keydown', onEsc)
  onBeforeUnmount(() => window.removeEventListener('keydown', onEsc))
})
```

- [ ] **Step 2: Browser-validate the caption fix**

```bash
playwright-cli goto "http://localhost:3000/agent"
# send: "List my active projects with a bulleted markdown summary"
# open full-bleed, then:
playwright-cli eval "() => { const c=document.querySelector('[aria-label=\"Voice mode\"]'); return c ? c.innerText : 'not open' }"
```
Expected: no literal `#` or `**` in the caption text. That was the visible proof of the same defect the TTS sanitizer fixes.

- [ ] **Step 3: Run the gates**

Run: `pnpm typecheck && pnpm test && pnpm build`

- [ ] **Step 4: Commit**

```bash
git add app/pages/agent/index.vue
git commit -m "feat(agent): full-bleed voice mode with a properly rendered caption"
```

---

## Task 17: Stand up Orpheus and choose the voice

**Files:**
- Modify: none in the repo (the model registry makes this configuration).
- Document: the chosen model + voice in the cycle handover.

**Interfaces:**
- Consumes: the TTS provider contract — any OpenAI-compatible `/v1/audio/speech`.
- Produces: nothing in code.

**This task is gated on rig work outside the app.** The app side is already config: `assignments.tts` in `ai_config` takes any OpenAI-spec endpoint, so no code and no redeploy.

- [ ] **Step 1: Serve Orpheus on the rig**

`vllm serve` the Orpheus 3B Llama backbone (FP8, ~8–9 GB on one 3090) → SNAC decoder (7-token frames, sliding window) → a FastAPI wrapper exposing `/v1/audio/speech` and `/v1/audio/voices`. Use `Lex-au/Orpheus-FastAPI` or `NoCodingAi/Orpheus-TTS-FastAPI-server`.

**Do NOT use the `orpheus-speech` PyPI package.** It returns HTTP 200 with an empty body — the internal SNAC post-processing never writes bytes into the response, independently reproduced at 100-concurrent. The symptom is "TTS silently returns nothing", which is expensive to diagnose. **Core vLLM does not serve TTS**; that lives in the separate `vllm-omni` subproject.

- [ ] **Step 2: Register it**

In `/settings` → AI providers: add an `openai-compatible` provider pointing at the new endpoint, add the Orpheus model, and put it at the **head** of the `tts` chain with Kokoro retained behind it as failover.

Verify the voice catalogue aggregates correctly:

```bash
curl -s http://localhost:3000/api/voice/voices | head -c 400
```
Expected: Orpheus's voices appear, each tagged with its model label. `tts-failover.ts`'s `pinChainToProvider` uses that label to dial the right provider first.

- [ ] **Step 3: Listen to the fixed paragraph**

Through each candidate, back to back:

> "Your six active projects are mymind, bridget-services and hermes-agent. The rig is at 192.168.2.25, running Qwen 3.6 on version 1.2 of the stack. Want me to dig into any of them?"

Order: **Orpheus 3B** (expected winner) → **Chatterbox Turbo** (the fallback; note the rig's *installed* Chatterbox is the original 0.5B, benchmarked at 4 s TTFB at concurrency 1, so it is not a shortcut) → **CosyVoice2/3** if turn-taking still feels slow → **Kokoro at `playbackRate: 1.0`** as the control.

Measure first-audio in the browser's network panel. If Orpheus exceeds ~500 ms on the 3090, drop to the 1B or 400M variant.

- [ ] **Step 4: Confirm the pipeline fixes landed in the audio**

Speak a turn that triggers a markdown-heavy reply containing an IP address. Expected: no pronounced asterisks, no seam mid-clause, and the IP spoken as one continuous phrase rather than four fragments.

- [ ] **Step 5: Record the decision**

Write the chosen model, voice and measured first-audio into the handover. Do not commit code for this task.

---

## Task 18: Wiki, roadmap, and handover

**Files:**
- Modify: `docs/wiki/agent.md`, `docs/wiki/voice-agent.md`
- Modify: `docs/superpowers/plans/00-roadmap.md`
- Modify: `docs/BACKLOG.md`
- Create: `docs/handovers/2026-08-27-agent-surface-redesign.md`

- [ ] **Step 1: Update the wiki to describe what now exists**

`docs/wiki/agent.md`: replace the "UI" section with the three-column layout, the thread rail, autoscroll, the message actions, and the empty state. `docs/wiki/voice-agent.md`: replace the chunking description with `segment.ts` + `speakable.ts`, record the new TTS model and voice, delete the 96-bar-ring section, and describe the mic band's two signals and the avatar's state table. Bump both `status`/`updated` headers.

The wiki describes **current behaviour** — never leave a page saying shipped work is unbuilt.

- [ ] **Step 2: Mirror to MyMind**

Both wiki pages are mirrored (`mcp__mymind__sync_document` with the file's `mymind_id` / `mymind_hash`, or `save_document` if absent). Write the returned `id` and `hash` back into the frontmatter.

- [ ] **Step 3: Add the roadmap row and write the handover**

Add cycle 60 to the table in `00-roadmap.md`. Write the handover with accurate frontmatter (`title`, `cycle: 60`, `date`, `status`, `branch`, `spec`, `plan`, `docs`, `tasks`), recording: measured gate results, the chosen TTS model + voice + first-audio, the MakeHuman export's CC0 provenance, and anything deferred.

- [ ] **Step 4: Close the task**

`mcp__mymind__edit_task` on `31494f84-f556-4ea4-a9a2-ea2fb0f09cd9` → `status: completed`, and open a follow-ups task for anything deferred.

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs(cycle-60): wiki, roadmap and handover for the agent surface redesign"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Layout & shell — three columns, resize constraint | 6 |
| `hidden lg:flex` / sub-1024 px | 6 |
| One toolbar, delete the `IDLE` readout | 6 |
| Autoscroll + "↓ new" | 7 |
| Composer: textarea, shift-enter, Stop | 8 |
| Messages: separation, copy/retry/timestamp/tokens | 9 (+ 4 for the column) |
| Empty state | 10 |
| Conversations sidebar entry | 5 |
| Thread rail | 6 |
| Current thread title | 6 |
| Delete confirms | 5 |
| `toSpeakable` | 1 |
| `segment` | 2 |
| Ordering + no leak into the transcript | 3 |
| `playbackRate` 1.0 | 3 |
| Orpheus migration + landmines | 17 |
| Mic device picker | 11 |
| Mic band (two signals) | 12 |
| `Avatar` seam | 13 |
| Mesh → point buffer | 14 |
| Baked attributes / `jawW` | 14 |
| Pose + pivot + pitch sign | 13, 15 |
| Choreography (injected RNG) | 13 |
| Column + full-bleed | 6, 16 |
| `usage jsonb` migration | 4 |
| Testing (unit + browser + live voice) | in each task; 17 for live voice |

**Placeholder scan:** no TBD/TODO; every code step carries real code; no "similar to Task N".

**Type consistency:** `Pose` (Task 13) is produced by `createChoreographer.step` and consumed by `ParticleHead` (15). `HeadMetrics`/`jawWeight`/`regionWeights` (14) are used only within 14. `Avatar` (13) is returned by `createParticleHead` (15) and mounted by `Avatar.client.vue` (15). `SpeechChunker` (2) matches `SentenceChunker`'s `push`/`flush` signature, which is why Task 3's call sites are unchanged. `TranscriptEntry.usage` (9) matches `conversation_messages.usage` (4).

**Two blocked-not-failed steps**, both flagged in-place: Task 14 Step 5 (needs the MakeHuman export) and Task 17 (needs Orpheus on the rig). Neither blocks any other task.
