// Stack review 2026-10-19 (D1): the write-time secret gate.
//
// One Clef call per candidate memory — `noul contains_secret` — before it is stored. On a 103-memory
// replay of the live store (M3 §E3) the 4 memories carrying a real credential VALUE scored
// 0.83–0.94 and the highest negative (a memory that merely NAMES secrets) scored 0.67, so 0.7 is a
// clean cut; the keyword regex on the same set was 7.5 % precise, which is why Clef is the trigger
// and the regex (redact-credentials.ts) only finds the spans afterwards.
//
// Policy, in order of importance:
//   1. Never drop. A flagged text is stored REDACTED and held for review; the caller decides how
//      (memory: reviewed_at NULL + the tag; quick_capture: the tag on the document).
//   2. Fail OPEN. Clef unreachable, slow (> SECRET_GATE_TIMEOUT_MS), unconfigured, or answering
//      without the noul ⇒ the text is inserted exactly as today, with a warning. A Clef outage
//      must never block a memory write.
//   3. Cheap. Prefill-only (~155 ms median direct, R6 §1.3), state clipped to SECRET_GATE_MAX_TOKENS.
//
// Config: settings key `secret_gate` → { enabled: true | false | 'auto', threshold }. Default
// `auto` = on exactly when the `jev` slot is assigned in the AI config (the same slot the scorer
// uses), so a box without Clef never pays for the lookup and never warns.

import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'
import { askJev, jevConfig, nouls, type JevConfig } from '../ai/jev'
import { estimateTokens } from '../chunking/chunk-markdown'
import { redactCredentials } from './redact-credentials'

export const SECRET_GATE_KEY = 'secret_gate'
/** M3 §E3: positives 0.83–0.94, highest negative 0.67. */
export const SECRET_GATE_THRESHOLD = 0.7
/** Fail open past this — the gate sits inline on every memory write. */
export const SECRET_GATE_TIMEOUT_MS = 1500
/** State clip (~5,700 chars). Memories median 428 tokens / max 714 on the replay; this is headroom. */
export const SECRET_GATE_MAX_TOKENS = 1500
/** The review marker on a flagged memory or note. */
export const SECRET_REVIEW_TAG = 'needs-review:secret'

export const SECRET_QUESTIONS = {
  contains_secret: {
    type: 'noul',
    instructions: 'The text contains a password, API key, token, private key, or connection string with credentials'
  }
} as const

export interface SecretGateConfig {
  /** `'auto'` (default) = enabled iff the `jev` slot is configured. */
  enabled: boolean | 'auto'
  threshold: number
}

export type SecretGateOutcome = 'off' | 'clear' | 'flagged' | 'unavailable'

export interface SecretGateResult {
  outcome: SecretGateOutcome
  /** `contains_secret` as answered; null when the gate did not run or got no usable answer. */
  score: number | null
  flagged: boolean
  /** The text to store: redacted when flagged, otherwise the input verbatim. */
  text: string
  /** Spans redacted (0 when not flagged, or flagged with nothing value-shaped to find). */
  redactions: number
}

/** Test seams, mirroring server/services/memory-scoring.ts's ScoreDeps. */
export interface SecretGateDeps {
  ask?: typeof askJev
  /** `undefined` = resolve from the AI config; `null` = Jev is off. */
  cfg?: JevConfig | null
  config?: SecretGateConfig
  warn?: (message: string) => void
}

const DEFAULT_CONFIG: SecretGateConfig = { enabled: 'auto', threshold: SECRET_GATE_THRESHOLD }

function parse(value: unknown): SecretGateConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_CONFIG }
  const v = value as Record<string, unknown>
  const enabled = typeof v.enabled === 'boolean' ? v.enabled : 'auto'
  const threshold = typeof v.threshold === 'number' && v.threshold > 0 && v.threshold <= 1 ? v.threshold : SECRET_GATE_THRESHOLD
  return { enabled, threshold }
}

/** Defaults on a missing or malformed stored value — never throws (same pattern as backfill-setting.ts). */
export async function getSecretGateConfig(): Promise<SecretGateConfig> {
  const [row] = await useDb().select().from(settings).where(eq(settings.key, SECRET_GATE_KEY)).limit(1)
  return parse(row?.value)
}

/** Reject with a TimeoutError once `ms` have passed, whether or not `p` ever settles. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DOMException(`secret gate deadline (${ms} ms) passed`, 'TimeoutError')), ms)
  })
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer))
}

function clip(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  return text.slice(0, Math.floor(maxTokens * 3.8))
}

/**
 * Redact every string field of each evidence entry (D3 A3). Enrichment's `evidence[0].quote` is the
 * extractor's VERBATIM transcript line — for a credential memory, exactly the line holding the value —
 * and `reasoning` often repeats it, so redacting `content` alone left the raw value one column over.
 * Non-object entries and non-string fields pass through untouched; `undefined` stays `undefined`.
 */
export function redactEvidence(evidence: unknown[] | undefined): unknown[] | undefined {
  if (!evidence) return evidence
  return evidence.map((e) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return e
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(e as Record<string, unknown>)) out[k] = typeof v === 'string' ? redactCredentials(v).text : v
    return out
  })
}

/** Append the review tag once, preserving order. */
export function withSecretReviewTag(tags: string[] | undefined): string[] {
  const out = tags ?? []
  return out.includes(SECRET_REVIEW_TAG) ? out : [...out, SECRET_REVIEW_TAG]
}

/**
 * Ask Clef whether `text` carries a credential value. See the header for the policy; in short:
 * flagged ⇒ `text` comes back redacted; anything else ⇒ `text` comes back untouched.
 */
export async function gateSecret(text: string, deps: SecretGateDeps = {}): Promise<SecretGateResult> {
  const warn = deps.warn ?? ((m: string) => console.warn(m))
  const untouched = (outcome: SecretGateOutcome, score: number | null = null): SecretGateResult =>
    ({ outcome, score, flagged: false, text, redactions: 0 })

  let config: SecretGateConfig
  let cfg: JevConfig | null
  try {
    config = deps.config ?? await getSecretGateConfig()
    cfg = deps.cfg === undefined ? await jevConfig() : deps.cfg
  } catch (err) {
    warn(`[secret gate] config unreadable, storing unredacted: ${(err as Error).message}`)
    return untouched('unavailable')
  }
  if (config.enabled === false || !cfg) return untouched('off')

  try {
    // One attempt (no 429 back-off) AND an overall deadline: `timeoutMs` bounds one fetch, but the
    // gate's promise is "unredacted within 1.5 s", whatever the client does underneath (D3 A2).
    const res = await withDeadline(
      (deps.ask ?? askJev)(clip(text, SECRET_GATE_MAX_TOKENS), SECRET_QUESTIONS, cfg, { timeoutMs: SECRET_GATE_TIMEOUT_MS, maxAttempts: 1 }),
      SECRET_GATE_TIMEOUT_MS
    )
    const score = nouls(res.answers).contains_secret
    if (typeof score !== 'number') {
      warn('[secret gate] Clef answered without contains_secret, storing unredacted')
      return untouched('unavailable')
    }
    if (score < config.threshold) return untouched('clear', score)
    const { text: redacted, hits } = redactCredentials(text)
    return { outcome: 'flagged', score, flagged: true, text: redacted, redactions: hits }
  } catch (err) {
    // Timeout (AbortSignal TimeoutError), network error, non-OK reply — all fail open.
    warn(`[secret gate] Clef unavailable, storing unredacted: ${(err as Error).message}`)
    return untouched('unavailable')
  }
}
