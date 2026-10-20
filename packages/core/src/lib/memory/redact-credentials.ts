// Stack review 2026-10-19 (D1): span-level credential redaction for the write-time secret gate.
//
// This is the scalpel, not the gate. On the live store a keyword regex matched 149 memories of
// which 5 held an actual value (7.5 % precise — M3 §E3), so nothing here decides whether a text
// is sensitive; Clef's `contains_secret` noul does (secret-gate.ts). Once it has, these patterns
// find the value-shaped spans and replace them, keeping the sentence around them readable so the
// memory stays useful ("the Mac Mini password is «redacted»" still tells you where to look).
//
// Deliberately NOT here: a generic "long random string" pattern. It would eat hashes, UUIDs and
// git SHAs, which the store is full of. A flagged memory whose value matches nothing below is
// still flagged and held for review — redaction is best-effort, the review hold is the guarantee.

/** Same marker the observability + sandbox maskers use, so a redacted span reads the same everywhere. */
export const REDACTED = '«redacted»'

export interface RedactResult {
  text: string
  /** Number of spans replaced (0 ⇒ nothing value-shaped was found). */
  hits: number
}

// A keyword must stand as its own word: no bare `auth` (it sat inside "author", "Authority",
// "OAuth" — D3 A1), a boundary on both sides so "tokens:" and "PROD_NEO4J_PASSWORD" do not match.
const KEYWORD = '(?<![A-Za-z0-9_])(?:password|passwd|pwd|passphrase|secret|token|api[_ -]?key|apikey|access[_ -]?key|private[_ -]?key|client[_ -]?secret|auth[_ -]?token)(?![A-Za-z0-9])'

// What a credential VALUE looks like once a keyword has named it: one unbroken run of at least
// eight non-space, non-quote characters that carries a digit or mixes upper and lower case.
// Ordinary words after "is"/":" ("that", "used", "for", "hello world", "Alice Smith") fail this;
// `Copenflagen11!`, `FlashNextDev2026`, `CorrectHorseBatteryStaple` pass. Pure-symbol/all-lower
// passwords are missed on purpose — the review hold is the guarantee, not this regex.
const VALUE_CHARS = '[^\\s"\'`,;«]'
const VALUE = `(?=${VALUE_CHARS}*(?:\\d|[a-z]${VALUE_CHARS}*[A-Z]|[A-Z]${VALUE_CHARS}*[a-z]))${VALUE_CHARS}{8,}`

// Order matters: whole blocks first (so the assignment pattern cannot nibble at "PRIVATE KEY-----"),
// then structured forms, then prose assignments.
const PATTERNS: { re: RegExp, repl: (m: RegExpExecArray) => string }[] = [
  // PEM private-key blocks, whole.
  { re: /-----BEGIN[^-\n]*PRIVATE KEY-----[\s\S]*?-----END[^-\n]*PRIVATE KEY-----/g, repl: () => REDACTED },
  // Credentials inside a URL: keep scheme + user, redact only the password. The password may
  // not contain `/`, which is what tells `user:pass@host` from `host:port/path@…` (D3 A1).
  { re: /(\w[\w+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/g, repl: m => `${m[1]}${REDACTED}${m[3]}` },
  // Bearer tokens.
  { re: /(\bBearer\s+)([A-Za-z0-9._~+/=-]{8,})/g, repl: m => `${m[1]}${REDACTED}` },
  // Well-known token prefixes (OpenAI/LiteLLM, HuggingFace, GitHub, Slack, MyMind API tokens, AWS, Google).
  { re: /\b(?:sk-[A-Za-z0-9_-]{8,}|hf_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|mm_[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g, repl: () => REDACTED },
  // `password is X`, `API_KEY=X`, `token: "X"`, `the password X` — a keyword, an optional
  // separator, then a value-shaped run. The separator can be optional only because VALUE is strict.
  { re: new RegExp(`(${KEYWORD}\\s*(?:[:=]|=>|\\bis\\b)?\\s*["'\`]?)(${VALUE})`, 'gi'), repl: m => `${m[1]}${REDACTED}` },
  // A quoted value shortly after a keyword: password for the API (`X`). Same value shape, so a
  // quoted phrase ("hello world") is never taken for a credential.
  { re: new RegExp(`(${KEYWORD}[^"'\`\\n]{0,40}?["'\`])(${VALUE})(["'\`])`, 'gi'), repl: m => `${m[1]}${REDACTED}${m[3]}` }
]

/** Replace every credential-shaped span in `text` with «redacted». Pure; never throws. */
export function redactCredentials(text: string): RedactResult {
  let out = text
  let hits = 0
  for (const { re, repl } of PATTERNS) {
    out = out.replace(re, (...args) => {
      hits++
      const m = args.slice(0, -2) as unknown as RegExpExecArray // drop offset + input
      return repl(m)
    })
  }
  return { text: out, hits }
}
