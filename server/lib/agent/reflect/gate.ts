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
import { similarity } from './similarity'

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
  /** Rejections of the last 30 days. */
  recentRejections: { kind: string; target: string; content: string }[]
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
export const SENSITIVE = /\b(exec|shell|command line|terminal|sudo|rm -rf|password|secret|token|api key|credential|delete|drop table)\b/i

/** Whitespace collapsed only — case and punctuation stay exact. No fuzzy matching. */
const normaliseWs = (s: string) => s.replace(/\s+/g, ' ').trim()

const isEdit = (k: Proposal['kind']) => k !== 'skill.create'
const isSkill = (k: Proposal['kind']) => k === 'skill.create' || k === 'skill.edit'

export function gate(p: Proposal, ctx: GateContext): GateResult {
  const drop = (reason: string): GateResult => ({ route: 'dropped', reasons: [reason] })

  // 1. Mode.
  if (ctx.mode === 'off') return drop('mode_off')

  // 2. Evidence: verbatim (whitespace-normalised) substrings of the transcript.
  const input = normaliseWs(ctx.input)
  if (!p.evidence.every(q => input.includes(normaliseWs(q)))) return drop('evidence')

  // 3. Rejection memory.
  const content = p.content ?? ''
  if (ctx.recentRejections.some(r => r.kind === p.kind && r.target === p.target && similarity(content, r.content) >= SIMILARITY_REJECT)) {
    return drop('rejected_recently')
  }

  // 4. Validity.
  const invalid = ctx.validate(p)
  if (invalid !== null) return drop(`invalid: ${invalid}`)
  if (isEdit(p.kind) && ctx.targetAuthor === 'missing') return drop('target_missing')

  // 5. Tier.
  let route: Route = 'review'
  const reasons: string[] = []
  if (p.kind === 'skill.create') route = 'auto'
  else if ((p.kind === 'skill.edit' || p.kind === 'job.edit') && ctx.targetAuthor === 'agent') route = 'auto'
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
