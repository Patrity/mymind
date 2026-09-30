// server/lib/agent/reflect/gate.ts
//
// The proposal gate (spec §5): plain, pure code that routes every reflector proposal to
// `auto` (apply now), `review` (Tony decides on /review) or `dropped` (recorded, never shown as
// actionable). Everything the gate needs — mode, authorship, recent rejections, validation,
// today's count, the Jev verdict — is gathered by the caller and passed in, so this file has no
// DB and no I/O. Steps run in spec order; drops stop at the first failing rule, demotions
// accumulate so /review can say every reason an item was not auto-applied.
import type { SelfImprovementMode } from '../self-improvement-mode'
import type { Proposal } from './schema'
import type { JevVerdict } from './jev'
import { contentDelta, similarity } from './similarity'

export type Route = 'auto' | 'review' | 'dropped'

export interface GateContext {
  mode: SelfImprovementMode
  /**
   * The evidence source: every evidence quote must appear in this text. It is the TRANSCRIPT the
   * reflector saw — for the thread pass the rendered conversation, for the jobs pass the signal
   * snippets plus the job content. It must NOT include the skills list or the About Tony profile
   * that were also in the prompt; otherwise quoting the existing profile or a skill would count as
   * evidence of Tony saying it.
   */
  input: string
  /** Who last authored the target: skill source / job source; 'human' for the profile; 'missing'
   *  when the target does not exist (fine for skill.create, a drop for any edit). */
  targetAuthor: 'human' | 'agent' | 'missing'
  /** The target's content at pass time ('' for a create, or a job.disable with nothing to compare). */
  currentContent: string
  /** Rejections of the last 30 days. `delta` is `contentDelta(rejected content, content at that
   *  pass)`, stored at rejection — the CHANGE Tony said no to, not the whole document. */
  recentRejections: { kind: string; target: string; delta: string }[]
  /** null = valid, else a reason (existing parsers/validators, skill size, profile budget). */
  validate: (p: Proposal) => string | null
  /** Proposals auto-applied so far today (agent timezone). */
  autoAppliedToday: number
  /** The target already changed in the last 24 hours. */
  targetChangedWithin24h: boolean
  jev: JevVerdict | 'unavailable'
}

/** `reasons` explains every drop and every step that kept the proposal out of `auto`. */
export interface GateResult { route: Route; reasons: string[] }

export const AUTO_PER_DAY = 5
export const SIMILARITY_REJECT = 0.8
export const SKILL_MAX_BYTES = 4096
/** Anything touching commands, credentials or deletion. Stems and plurals on purpose: a false
 *  positive only routes a skill to review, a miss auto-applies it. */
export const SENSITIVE = /\b(exec\w*|shells?|commands?|command[\s-]line|terminals?|sudo|rm\s+-(?:rf|fr)|passwords?|secrets?|tokens?|api[\s_-]?keys?|credentials?|delet\w*|drop\s+table)\b/i
/** An evidence quote shorter than this (whitespace-normalised) is a substring of nearly any
 *  transcript, so it proves nothing. */
export const EVIDENCE_MIN_CHARS = 12

/** Whitespace collapsed only — case and punctuation stay exact. No fuzzy matching. */
const normaliseWs = (s: string) => s.replace(/\s+/g, ' ').trim()

const isEdit = (k: Proposal['kind']) => k !== 'skill.create'
const isSkill = (k: Proposal['kind']) => k === 'skill.create' || k === 'skill.edit'

export function gate(p: Proposal, ctx: GateContext): GateResult {
  const drop = (reason: string): GateResult => ({ route: 'dropped', reasons: [reason] })

  // 1. Mode.
  if (ctx.mode === 'off') return drop('mode_off')

  // 2. Evidence: verbatim (whitespace-normalised) substrings of the transcript, long enough to mean something.
  if (p.evidence.some(q => normaliseWs(q).length < EVIDENCE_MIN_CHARS)) return drop('evidence_too_short')
  const input = normaliseWs(ctx.input)
  if (!p.evidence.every(q => input.includes(normaliseWs(q)))) return drop('evidence')

  // 3. Rejection memory, on the change rather than the document: otherwise one rejected edit to a
  //    long profile/skill would silence every later edit to it for 30 days. Empty deltas never match
  //    (checking the proposal side suffices: similarity is only non-zero when both sides have shingles).
  const content = p.content ?? ''
  const delta = contentDelta(content, ctx.currentContent)
  if (delta && ctx.recentRejections.some(r => r.kind === p.kind && r.target === p.target && similarity(delta, r.delta) >= SIMILARITY_REJECT)) {
    return drop('rejected_recently')
  }

  // 4. Validity.
  const invalid = ctx.validate(p)
  if (invalid !== null) return drop(`invalid: ${invalid}`)
  if (isEdit(p.kind) && ctx.targetAuthor === 'missing') return drop('target_missing')

  // 5. Tier.
  let route: Route = 'review'
  const reasons: string[] = []
  //    A skill.create whose slug already exists is tiered as an edit of that skill.
  if (p.kind === 'skill.create' && ctx.targetAuthor === 'missing') route = 'auto'
  else if ((p.kind === 'skill.create' || p.kind === 'skill.edit' || p.kind === 'job.edit') && ctx.targetAuthor === 'agent') route = 'auto'
  else reasons.push('tier')

  // 6–9 only ever demote. Sensitivity and Jev are facts about the proposal, noted even on an item
  // already in review so /review shows them; caps and review_only are about `auto` and apply only to it.
  const demote = (reason: string) => { route = 'review'; reasons.push(reason) }

  // 6. Sensitive skill content.
  if (isSkill(p.kind) && SENSITIVE.test(content)) demote('sensitive')

  // 7. Jev — one-way: it can demote, never promote.
  if (ctx.jev === 'unavailable') demote('jev_unavailable')
  else if (ctx.jev.risky) demote('jev_risky')

  // 8. Caps.
  if (route === 'auto' && (ctx.autoAppliedToday >= AUTO_PER_DAY || ctx.targetChangedWithin24h)) demote('cap')

  // 9. review_only mode.
  if (route === 'auto' && ctx.mode === 'review_only') demote('review_only')

  return { route, reasons }
}
