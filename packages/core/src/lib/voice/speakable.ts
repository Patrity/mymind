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

/** IPv4 octets: hundreds digit as-is, then the remainder 0-99. E.g., 192 -> "one ninety two", 100 -> "one zero zero". */
function ipv4GroupToWords(n: number): string {
  if (n >= 100) {
    const h = Math.floor(n / 100)
    const r = n % 100
    if (r === 0) {
      return `${ONES[h]} zero zero`
    } else if (r < 10) {
      return `${ONES[h]} zero ${ONES[r]}`
    } else {
      return `${ONES[h]} ${numberToWords(r)}`
    }
  }
  return numberToWords(n)
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
    (_m, a, b, c, d) => [a, b, c, d].map((g: string) => ipv4GroupToWords(Number(g))).join(' dot '))

  // Versions: "v1.2" and a bare "3.6". Integer part as a number, fraction digit-by-digit.
  // Negative lookbehind prevents matching if preceded by digit+dot (part of a 3+ component).
  // Negative lookahead prevents matching if followed by dot+digit (part of a 3+ component).
  s = s.replace(/(?<!\d\.)\bv(\d+)\.(\d+)(?!\.\d)\b/gi,
    (_m, maj, min) => `version ${numberToWords(Number(maj))} point ${digitsToWords(min)}`)
  s = s.replace(/(?<!\d\.)\b(\d+)\.(\d+)(?!\.\d)\b/g,
    (_m, maj, min) => `${numberToWords(Number(maj))} point ${digitsToWords(min)}`)

  // App routes read as page names rather than spelled slashes.
  s = s.replace(/(^|\s)\/([a-z][a-z0-9-]*)\b/g, '$1the $2 page')

  // Collapse whatever whitespace the removals created.
  return s.replace(/\s+/g, ' ').trim()
}
