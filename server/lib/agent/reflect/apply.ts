// server/lib/agent/reflect/apply.ts
//
// From a reflector proposal to an outcome (spec §5–§6). processProposal gathers everything the
// pure gate needs (mode, target author, recent rejections, validation, today's auto count, 24 h
// change, Jev), records the proposal in agent_improvements whatever happens to it, then:
//   auto   → applyImprovement (CAS on the hash read at pass time) → applied | conflict → /review
//   review → a `self-improvement` review_queue row                 → pending_review
//   drop   → recorded with its drop_reason                          → dropped
// applyImprovement is also what the /review approve handler calls, as actor 'human'.
//
// `agent_improvements.proposal` holds a StoredProposal: the reflector's Proposal plus
//   - expectedHash:   the target's content hash the apply CASes against (null for a create);
//   - currentContent: the target's content at pass time ('' for a create) — the /review diff base;
//     both are refreshed to the target's CURRENT state when an apply hits a CAS conflict, so the
//     next approve applies against what Tony now sees;
//   - reasons:        every gate reason (drops and demotions);
//   - delta:          written at rejection — contentDelta(rejected content, currentContent), the
//     CHANGE Tony said no to. The gate's rejection memory compares against it for 30 days.
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentConfigRevisions, agentImprovements, reviewQueue } from '../../../db/schema'
import { publishChange } from '../../../utils/live-bus'
import { ConflictError, getSkillSource, parseSkillMarkdown, saveSkillSource, validateSkill } from '../../../services/skills'
import { getProfileSource, saveProfileSource } from '../../../services/profile'
import { getJob, saveJob, setJobEnabled, getDefaultTimezone } from '../jobs/store'
import { parseJob } from '../jobs/parse'
import { activeHoursNeverMatchError } from '../jobs/schedule'
import { getSelfImprovementMode } from '../self-improvement-mode'
import { estimateTokens, PROFILE_TOKEN_BUDGET } from '../profile-budget'
import { setFrontmatterKey, splitFrontmatter } from '../../../../shared/utils/frontmatter'
import type { RevisionActor, RevisionTargetKind } from '../config/revisions'
import { gate, SKILL_MAX_BYTES, type GateContext, type Route } from './gate'
import { jevCheck, type JevVerdict } from './jev'
import { contentDelta } from './similarity'
import type { Proposal } from './schema'

export const REJECTION_MEMORY_MS = 30 * 24 * 3600_000
export const TARGET_CHANGE_WINDOW_MS = 24 * 3600_000

export interface StoredProposal extends Proposal {
  expectedHash: string | null
  currentContent: string
  reasons: string[]
  delta?: string
}

export interface ProposalSource {
  pass: 'thread' | 'jobs'
  conversationId: string | null
  runIds: string[]
  /** The evidence source (GateContext.input): the transcript, or the job's snippets + content. */
  input: string
  /** The target's content hash when the pass read it — BEFORE the model call; null for a create. */
  expectedHash: string | null
  /** The target's content read together with `expectedHash` (the diff base). When omitted the
   *  target is read now; passes always pass it, so hash and diff base describe the same version. */
  baseContent?: string
  /** Thread pass: the skills whose FULL file the reflector saw. An edit of any other existing skill
   *  was written blind and is dropped (`invalid: body_not_shown`). Omitted → not checked. */
  shownSkills?: string[]
}

export type ProcessStatus = 'applied' | 'pending_review' | 'dropped' | 'conflict'

const isSkill = (k: Proposal['kind']) => k === 'skill.create' || k === 'skill.edit'
const isJob = (k: Proposal['kind']) => k === 'job.edit' || k === 'job.disable'

interface TargetState {
  author: GateContext['targetAuthor']
  content: string
  /** Jobs only: whether the job is enabled now. */
  enabled?: boolean
  /** agent_config_revisions key; null when the target does not exist. */
  revisionKey: { kind: RevisionTargetKind; id: string | null } | null
}

async function readTarget(p: Proposal): Promise<TargetState> {
  if (isSkill(p.kind)) {
    const s = await getSkillSource(p.target)
    return s ? { author: s.source, content: s.content, revisionKey: { kind: 'skill', id: s.id } } : { author: 'missing', content: '', revisionKey: null }
  }
  if (isJob(p.kind)) {
    const j = await getJob(p.target)
    return j ? { author: j.source, content: j.content, enabled: j.enabled, revisionKey: { kind: 'job', id: j.id } } : { author: 'missing', content: '', revisionKey: null }
  }
  // The profile is always Tony's (D2: profile edits always need his approval). It is a singleton,
  // so its revisions are keyed by kind alone.
  const prof = await getProfileSource()
  return { author: 'human', content: prof.content, revisionKey: { kind: 'profile', id: null } }
}

/**
 * Skill authorship lives in the file's `source:` frontmatter. A new skill is Bridget's; an edit
 * keeps the skill's current author — so an approved edit to Tony's skill stays his, and a
 * proposal can't make a Tony skill "agent-authored" (and thus auto-editable) by rewriting that line.
 */
function withSkillSource(p: Proposal, target: TargetState): Proposal {
  if (!isSkill(p.kind) || !p.content) return p
  return { ...p, content: setSkillSource(p.content, target.author === 'missing' ? 'agent' : target.author) }
}

function setSkillSource(content: string, source: 'human' | 'agent'): string {
  return splitFrontmatter(content).error ? content : setFrontmatterKey(content, 'source', source)
}

/** A job file's `enabled`, or null when it doesn't parse. */
function jobEnabled(content: string, defaultTimezone: string): boolean | null {
  const parsed = parseJob(content, { defaultTimezone })
  return parsed.ok ? parsed.spec.enabled : null
}

function validator(defaultTimezone: string, target: TargetState, src: ProposalSource): (p: Proposal) => string | null {
  return (p) => {
    if (p.kind === 'job.disable') return null
    const content = p.content ?? ''
    if (!content.trim()) return 'content is required'
    if (isSkill(p.kind)) {
      // A create over an existing slug is an edit too: either way it replaces a file.
      if (src.shownSkills && target.author !== 'missing' && !src.shownSkills.includes(p.target)) return 'body_not_shown'
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > SKILL_MAX_BYTES) return `skill is ${bytes} bytes (max ${SKILL_MAX_BYTES})`
      const { input, error } = parseSkillMarkdown(content)
      if (error) return `frontmatter: ${error}`
      const v = validateSkill(input)
      if (!v.ok) return v.error
      if (input.name !== p.target) return `frontmatter name "${input.name}" must match the target "${p.target}"`
      return null
    }
    if (p.kind === 'profile.edit') {
      const tokens = estimateTokens(content)
      return tokens > PROFILE_TOKEN_BUDGET ? `profile is ~${tokens} tokens (max ${PROFILE_TOKEN_BUDGET})` : null
    }
    const parsed = parseJob(content, { defaultTimezone })
    if (!parsed.ok) return parsed.error
    return activeHoursNeverMatchError(parsed.spec)
  }
}

/** Auto-applies since midnight in the agent timezone (spec §5.8: ≤ 5 per day). */
export async function countAutoAppliedToday(): Promise<number> {
  const tz = await getDefaultTimezone()
  const res = await useDb().execute(sql`
    select count(*)::int as n from agent_improvements i
    where i.route = 'auto' and i.status = 'applied'
      and i.decided_at >= (date_trunc('day', now() at time zone ${tz}) at time zone ${tz})
      -- applied BY THE AGENT: an auto proposal that conflicted and Tony then approved is his change.
      and exists (select 1 from agent_config_revisions r where r.improvement_id = i.id and r.actor = 'agent')`)
  return Number((res.rows[0] as { n: number } | undefined)?.n ?? 0)
}

/** Any revision of the target in the last 24 h, whoever wrote it. */
async function changedWithin24h(key: TargetState['revisionKey']): Promise<boolean> {
  if (!key) return false
  const since = new Date(Date.now() - TARGET_CHANGE_WINDOW_MS)
  const [row] = await useDb().select({ id: agentConfigRevisions.id }).from(agentConfigRevisions).where(and(
    eq(agentConfigRevisions.targetKind, key.kind),
    key.id ? eq(agentConfigRevisions.targetId, key.id) : undefined,
    gte(agentConfigRevisions.createdAt, since)
  )).limit(1)
  return !!row
}

/** skill.create and skill.edit of one slug are one family: a create over an existing slug is an edit. */
const kindFamily = (kind: Proposal['kind']): Proposal['kind'][] => isSkill(kind) ? ['skill.create', 'skill.edit'] : [kind]

/** Rejections of this kind (family) + target in the last 30 days, reported under `kind` for the gate. */
async function recentRejections(kind: Proposal['kind'], target: string): Promise<{ kind: string; target: string; delta: string }[]> {
  const since = new Date(Date.now() - REJECTION_MEMORY_MS)
  const rows = await useDb().select({ proposal: agentImprovements.proposal }).from(agentImprovements).where(and(
    eq(agentImprovements.status, 'rejected'),
    inArray(agentImprovements.kind, kindFamily(kind)),
    eq(agentImprovements.target, target),
    gte(agentImprovements.decidedAt, since)
  ))
  return rows.map(r => ({ kind, target, delta: (r.proposal as Partial<StoredProposal>).delta ?? '' }))
}

async function recordImprovement(
  p: Proposal, src: ProposalSource, stored: StoredProposal, route: Route,
  jev: JevVerdict | 'unavailable' | null, dropReason: string | null
): Promise<string> {
  const [row] = await useDb().insert(agentImprovements).values({
    pass: src.pass,
    sourceConversationId: src.conversationId,
    sourceRunIds: src.runIds,
    kind: p.kind,
    target: p.target,
    proposal: stored,
    jev: jev && jev !== 'unavailable' ? jev : null,
    route,
    dropReason,
    status: route === 'dropped' ? 'dropped' : 'pending_review',
    decidedAt: route === 'dropped' ? new Date() : null
  }).returning({ id: agentImprovements.id })
  publishChange({ resource: 'agentImprovement', action: 'created', id: row!.id })
  return row!.id
}

async function enqueueReview(improvementId: string, stored: StoredProposal, src: ProposalSource, jev: JevVerdict | 'unavailable'): Promise<string> {
  const { expectedHash: _h, currentContent, reasons, delta: _d, ...proposal } = stored
  const [item] = await useDb().insert(reviewQueue).values({
    targetKind: 'improvement',
    targetId: improvementId,
    kind: 'self-improvement',
    proposed: { improvementId, proposal, reasons, jev, currentContent, conversationId: src.conversationId }
  }).returning({ id: reviewQueue.id })
  await useDb().update(agentImprovements).set({ reviewItemId: item!.id }).where(eq(agentImprovements.id, improvementId))
  publishChange({ resource: 'review', action: 'created', id: item!.id })
  return item!.id
}

export async function processProposal(
  proposal: Proposal,
  src: ProposalSource,
  deps: { jev?: typeof jevCheck } = {}
): Promise<{ improvementId: string; status: ProcessStatus }> {
  const target = await readTarget(proposal)
  const p = withSkillSource(proposal, target)
  // The diff base is the content the pass read WITH expectedHash (before its model call), so an
  // edit landing mid-call shows up as a CAS conflict, never as a silent revert. '' for a create
  // (the whole file is the change); a job.disable has no content, so its delta is always '' and
  // never matches — it is remembered by kind + target below instead.
  const currentContent = src.baseContent ?? (target.author === 'missing' ? '' : target.content)
  const stored: StoredProposal = { ...p, expectedHash: src.expectedHash, currentContent, reasons: [] }

  // A job.disable Tony rejected in the last 30 days is not asked again (it has no content to compare).
  if (p.kind === 'job.disable' && (await recentRejections(p.kind, p.target)).length) {
    stored.reasons = ['rejected_recently']
    return { improvementId: await recordImprovement(p, src, stored, 'dropped', null, 'rejected_recently'), status: 'dropped' }
  }

  const defaultTimezone = await getDefaultTimezone()
  const ctx: GateContext = {
    mode: await getSelfImprovementMode(),
    input: src.input,
    targetAuthor: target.author,
    currentContent,
    recentRejections: await recentRejections(p.kind, p.target),
    validate: validator(defaultTimezone, target, src),
    autoAppliedToday: await countAutoAppliedToday(),
    targetChangedWithin24h: await changedWithin24h(target.revisionKey),
    jev: 'unavailable'
  }
  // Drops (mode, evidence, rejection memory, validity) never depend on Jev: don't ask it about
  // a proposal that is dropped anyway.
  let result = gate(p, ctx)
  let jev: JevVerdict | 'unavailable' | null = null
  if (result.route !== 'dropped') {
    jev = await (deps.jev ?? jevCheck)(p)
    // The mode is re-read just before applying (spec §9): the Jev call takes seconds.
    result = gate(p, { ...ctx, mode: await getSelfImprovementMode(), jev })
  }
  // Turning a job on or off is Tony's call (D2): a job.edit that changes `enabled`, in either
  // direction, never auto-applies — it would otherwise be a job.disable that skips /review.
  if (result.route !== 'dropped' && p.kind === 'job.edit' && target.enabled !== undefined) {
    const next = jobEnabled(p.content ?? '', defaultTimezone)
    if (next !== null && next !== target.enabled) result = { route: 'review', reasons: [...result.reasons, 'changes_enabled'] }
  }
  stored.reasons = result.reasons

  const improvementId = await recordImprovement(p, src, stored, result.route, jev, result.route === 'dropped' ? result.reasons[0] ?? null : null)
  if (result.route === 'dropped') return { improvementId, status: 'dropped' }
  if (result.route === 'review') {
    await enqueueReview(improvementId, stored, src, jev ?? 'unavailable')
    return { improvementId, status: 'pending_review' }
  }

  let applied: Awaited<ReturnType<typeof applyImprovement>>
  try {
    applied = await applyImprovement(improvementId, 'agent')
  } catch (err) {
    // Not a CAS conflict (e.g. the job no longer validates against the model registry): record
    // why, never leave a pending row with no review item.
    const reason = `apply_failed: ${(err as Error)?.message ?? String(err)}`.slice(0, 300)
    await useDb().update(agentImprovements).set({ status: 'dropped', dropReason: reason, decidedAt: new Date() })
      .where(eq(agentImprovements.id, improvementId))
    publishChange({ resource: 'agentImprovement', action: 'updated', id: improvementId })
    return { improvementId, status: 'dropped' }
  }
  if (applied.ok) return { improvementId, status: 'applied' }
  // CAS conflict: applyImprovement refreshed currentContent/expectedHash; Tony decides with the fresh content.
  const [row] = await useDb().select().from(agentImprovements).where(eq(agentImprovements.id, improvementId)).limit(1)
  await enqueueReview(improvementId, row!.proposal as StoredProposal, src, jev ?? 'unavailable')
  return { improvementId, status: 'conflict' }
}

/**
 * Write an improvement through the target's own store (CAS on the stored expectedHash), tagging
 * the revision with `improvementId`. On success the row becomes `applied` with its revision id.
 * On a CAS conflict nothing is written; the row becomes `conflict` with expectedHash/currentContent
 * refreshed to what is there now, and the fresh content is returned.
 */
export async function applyImprovement(
  improvementId: string,
  actor: 'agent' | 'human'
): Promise<
  | { ok: true; revisionId: string | null }
  // `content` is the proposal's content after the refresh (its `source:` line may have changed).
  | { ok: false; conflict: { content: string; contentHash: string }; content: string | undefined }
> {
  const db = useDb()
  const [row] = await db.select().from(agentImprovements).where(eq(agentImprovements.id, improvementId)).limit(1)
  if (!row) throw new Error(`no improvement ${improvementId}`)
  const sp = row.proposal as StoredProposal
  const content = sp.content ?? ''
  const revActor: RevisionActor = actor
  const opts = { improvementId }
  try {
    switch (sp.kind) {
      case 'skill.create':
      case 'skill.edit':
        // expectedHash null → create; a create over an existing slug carries that skill's hash.
        await saveSkillSource(sp.target, content, sp.expectedHash, revActor, opts)
        break
      case 'job.edit':
        await saveJob(sp.target, content, sp.expectedHash, revActor, null, opts)
        break
      case 'job.disable':
        await setJobEnabled(sp.target, false, revActor, null, sp.expectedHash ?? '', opts)
        break
      case 'profile.edit':
        await saveProfileSource(content, sp.expectedHash ?? '', revActor, opts)
        break
    }
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err
    // A skill's author may have changed underneath (Tony created the slug, or relabelled his file):
    // re-derive the `source:` line from the CURRENT file, so approving can't relabel his skill.
    const refreshedContent = (sp.kind === 'skill.create' || sp.kind === 'skill.edit') && sp.content
      ? setSkillSource(sp.content, parseSkillMarkdown(err.current.content).input.source)
      : sp.content
    const refreshed: StoredProposal = { ...sp, content: refreshedContent, expectedHash: err.current.contentHash, currentContent: err.current.content }
    await db.update(agentImprovements).set({ status: 'conflict', proposal: refreshed }).where(eq(agentImprovements.id, improvementId))
    publishChange({ resource: 'agentImprovement', action: 'updated', id: improvementId })
    return { ok: false, conflict: err.current, content: refreshedContent }
  }

  const [rev] = await db.select({ id: agentConfigRevisions.id }).from(agentConfigRevisions)
    .where(eq(agentConfigRevisions.improvementId, improvementId))
    .orderBy(desc(agentConfigRevisions.createdAt)).limit(1)
  const revisionId = rev?.id ?? null
  await db.update(agentImprovements).set({ status: 'applied', revisionId, decidedAt: new Date() }).where(eq(agentImprovements.id, improvementId))
  publishChange({ resource: 'agentImprovement', action: 'updated', id: improvementId })
  return { ok: true, revisionId }
}

/** Tony rejected it on /review: remember the change he said no to (StoredProposal.delta) for 30 days. */
export async function rejectImprovement(improvementId: string): Promise<void> {
  const db = useDb()
  const [row] = await db.select().from(agentImprovements).where(eq(agentImprovements.id, improvementId)).limit(1)
  if (!row) throw new Error(`no improvement ${improvementId}`)
  const sp = row.proposal as StoredProposal
  const delta = contentDelta(sp.content ?? '', sp.currentContent ?? '')
  await db.update(agentImprovements).set({ status: 'rejected', decidedAt: new Date(), proposal: { ...sp, delta } })
    .where(eq(agentImprovements.id, improvementId))
  publishChange({ resource: 'agentImprovement', action: 'updated', id: improvementId })
}
