// server/lib/agent/reflect/thread-pass.ts
//
// The per-thread reflection pass (spec §4.1): for each settled thread (threadCandidates), render
// the messages since its watermark, ask the reflector once, route every proposal through
// processProposal, and advance the watermark — also on zero proposals. A failed or unparseable
// reply is retried once on the next tick; the second failure advances the watermark with no
// proposals, so a thread never blocks forever (spec §4.3, Review Focus 2).
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { useDb } from '../../../db'
import { agentImprovements, conversationMessages } from '../../../db/schema'
import type { chat } from '../../ai/chat'
import { getSkillSource, listSkills } from '../../../services/skills'
import { getProfileSource } from '../../../services/profile'
import { getSelfImprovementMode } from '../self-improvement-mode'
import { threadCandidates, markReflected } from './candidates'
import { buildThreadTranscript, tonyMessages } from './transcript'
import { skillFilesForPrompt, threadReflectionMessages } from './prompt'
import { callReflector } from './call'
import { processProposal, REJECTION_MEMORY_MS } from './apply'
import type { jevCheck } from './jev'
import type { Proposal } from './schema'

const THREAD_KINDS: Proposal['kind'][] = ['skill.create', 'skill.edit', 'profile.edit']
/** Newest rows read per thread; the transcript keeps the newest 24k chars of them anyway. */
const MESSAGE_LIMIT = 400
const REJECTION_TITLES = 20

/** Threads whose last reflector call failed and get one retry. In memory: one retry per process
 *  is acceptable (a restart grants another). */
const retryPending = new Set<string>()

type PassOpts = { now?: Date; onlyConversationIds?: string[]; chatFn?: typeof chat; jev?: typeof jevCheck }

async function newMessages(conversationId: string, since: Date | null) {
  // Millisecond-truncated like threadCandidates: the watermark is a JS Date.
  const rows = await useDb().select({
    id: conversationMessages.id, role: conversationMessages.role, content: conversationMessages.content,
    toolCalls: conversationMessages.toolCalls, createdAt: conversationMessages.createdAt
  }).from(conversationMessages).where(and(
    eq(conversationMessages.conversationId, conversationId),
    since ? sql`date_trunc('milliseconds', ${conversationMessages.createdAt}) > ${since.toISOString()}::timestamptz` : undefined
  )).orderBy(desc(conversationMessages.createdAt)).limit(MESSAGE_LIMIT)
  return rows.reverse()
}

async function rejectionTitles(): Promise<string[]> {
  const rows = await useDb().select({ kind: agentImprovements.kind, target: agentImprovements.target, proposal: agentImprovements.proposal })
    .from(agentImprovements).where(and(
      eq(agentImprovements.pass, 'thread'),
      eq(agentImprovements.status, 'rejected'),
      gte(agentImprovements.decidedAt, new Date(Date.now() - REJECTION_MEMORY_MS))
    )).orderBy(desc(agentImprovements.decidedAt)).limit(REJECTION_TITLES)
  return rows.map(r => `${r.kind} ${r.target}: ${(r.proposal as { reason?: string }).reason ?? ''}`.trim())
}

type Snapshot = { content: string; contentHash: string }

/** The target as the pass showed it to the model — read BEFORE the call, so a concurrent edit is
 *  a CAS conflict at apply time. A skill.create over an existing slug is an edit of that skill. */
function targetAtPass(p: Proposal, profile: Snapshot, skills: Map<string, Snapshot>): { expectedHash: string | null; baseContent: string } {
  const snap = p.kind === 'profile.edit' ? profile : skills.get(p.target)
  return snap ? { expectedHash: snap.contentHash, baseContent: snap.content } : { expectedHash: null, baseContent: '' }
}

async function reflectThread(conversationId: string, since: Date | null, opts: PassOpts): Promise<number> {
  const msgs = await newMessages(conversationId, since)
  if (!msgs.length) return 0
  const through = msgs[msgs.length - 1]!.createdAt
  const transcript = buildThreadTranscript(msgs)
  // Snapshot every target the model may rewrite, together with its hash, before the call.
  const skills = await Promise.all((await listSkills()).map(async (s) => {
    const src = await getSkillSource(s.name)
    return { name: s.name, description: s.description, source: s.source, active: s.active, content: src?.content, contentHash: src?.contentHash }
  }))
  const skillSnaps = new Map(skills.filter(s => s.content !== undefined && s.contentHash !== undefined)
    .map(s => [s.name, { content: s.content!, contentHash: s.contentHash! }]))
  const profile = await getProfileSource()
  const shownSkills = [...skillFilesForPrompt(skills)].filter(([, f]) => f.full).map(([name]) => name)
  const messages = threadReflectionMessages({
    transcript,
    skills,
    profile: profile.content,
    recentRejections: await rejectionTitles()
  })

  const res = await callReflector(messages, THREAD_KINDS, { chatFn: opts.chatFn })
  if (!res.ok) {
    if (!retryPending.has(conversationId)) {
      retryPending.add(conversationId)
      console.warn(`[reflect] thread ${conversationId}: ${res.error} — retrying next tick`)
      return 0
    }
    retryPending.delete(conversationId)
    console.warn(`[reflect] thread ${conversationId}: ${res.error} — second failure, advancing with no proposals`)
    await markReflected(conversationId, through)
    return 0
  }
  retryPending.delete(conversationId)

  for (const p of res.proposals) {
    try {
      // Evidence is checked against the transcript ONLY — never the skills list or profile that
      // were also in the prompt (Task 5 ruling).
      await processProposal(p, {
        pass: 'thread', conversationId, runIds: [], input: transcript, userInput: tonyMessages(msgs), shownSkills,
        ...targetAtPass(p, profile, skillSnaps)
      }, { jev: opts.jev })
    } catch (err) {
      console.warn(`[reflect] thread ${conversationId}: proposal ${p.kind} ${p.target} failed:`, err)
    }
  }
  await markReflected(conversationId, through)
  return res.proposals.length
}

export async function runThreadPass(opts: PassOpts = {}): Promise<{ threads: number; proposals: number }> {
  if (await getSelfImprovementMode() === 'off') return { threads: 0, proposals: 0 }
  const candidates = await threadCandidates({ now: opts.now, onlyConversationIds: opts.onlyConversationIds })
  let threads = 0
  let proposals = 0
  for (const c of candidates) {
    try {
      proposals += await reflectThread(c.conversationId, c.since, opts)
      threads++
    } catch (err) {
      console.warn(`[reflect] thread ${c.conversationId} failed:`, err)
    }
  }
  return { threads, proposals }
}
