// test/review-decisions.db.test.ts
//
// DB-backed — cycle 76, Task 9: decideReview, the path shared by the /review routes and Bridget's
// decide_review tool. The dev DB is SHARED with real data:
//   - every row this file writes is created here and collected by id (review rows, memories,
//     relations, improvements, the scratch conversation) or carries the `rdec-<run>-` prefix
//     (skills, memory content/hash), and is deleted in afterAll;
//   - the agent-action replay target is `get_job` on a slug that doesn't exist (a read, no write);
//   - the self_improvement_mode setting is snapshotted and restored. Jev is a stub; no model call.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
vi.stubGlobal('createError', (o: { statusCode: number, message?: string, statusMessage?: string }) =>
  Object.assign(new Error(o.message ?? o.statusMessage ?? 'err'), o))
// The route files are Nitro handlers: run them as plain functions of a fake event. Hoisted —
// their `export default defineEventHandler(…)` runs at import time.
vi.hoisted(() => {
  Object.assign(globalThis, {
    defineEventHandler: (h: unknown) => h,
    getRouterParam: (e: { params: Record<string, string> }, k: string) => e.params[k],
    readBody: async (e: { body: unknown }) => e.body
  })
})

import { randomUUID, createHash } from 'node:crypto'
import { and, eq, inArray, like } from 'drizzle-orm'
import { useDb } from '../server/db'
import {
  agentConfigRevisions, agentImprovements, agentSkills, conversationMessages, conversations,
  memories, memoryRelations, reviewQueue, settings
} from '../server/db/schema'
import { decideReview, listPendingReviews } from '../server/services/review-decisions'
import { createConversation } from '../server/services/conversations'
import { getSkillSource, saveSkillSource } from '../server/services/skills'
import { SELF_IMPROVEMENT_MODE_KEY, setSelfImprovementMode } from '../server/lib/agent/self-improvement-mode'
import { processProposal } from '../server/lib/agent/reflect/apply'
import type { JevVerdict } from '../server/lib/agent/reflect/jev'
import { hasUndo, runUndo } from '../server/lib/agent/undo'
import { buildAiTools } from '../server/lib/agent/ai-tools'
import { decideReviewTool } from '../server/lib/agent/tools/reviews'
import approveRoute from '../server/api/review/[id]/approve.post'
import rejectRoute from '../server/api/review/[id]/reject.post'
import resolveRoute from '../server/api/review/[id]/resolve.post'

const db = () => useDb()
const TAG = `rdec-${Date.now().toString(36)}-`
const reviewIds: string[] = []
const memoryIds: string[] = []
const improvementIds: string[] = []
const convIds: string[] = []
let modeSnapshot: typeof settings.$inferSelect | null = null
let conversationId = ''

type Route = (e: unknown) => Promise<unknown>
const callRoute = (route: unknown, id: string, body?: unknown) =>
  (route as Route)({ params: { id }, body }).catch((e: { statusCode?: number, statusMessage?: string, message?: string, data?: unknown }) => ({ thrown: e }))

async function queueRow(kind: string, proposed: unknown, targetKind = 'agent_run', targetId: string = randomUUID()) {
  const [row] = await db().insert(reviewQueue).values({ targetKind, targetId, kind, proposed }).returning()
  reviewIds.push(row!.id)
  return row!
}
async function status(id: string) {
  const [row] = await db().select({ status: reviewQueue.status }).from(reviewQueue).where(eq(reviewQueue.id, id))
  return row?.status
}
let memorySeq = 0
async function memory(label: string, reviewed = true) {
  const content = `${TAG}${label}-${++memorySeq}`
  const [row] = await db().insert(memories).values({
    content, contentHash: createHash('sha256').update(content).digest('hex'), scope: 'user',
    reviewedAt: reviewed ? new Date() : null
  }).returning({ id: memories.id })
  memoryIds.push(row!.id)
  return row!.id
}
async function memoryRow(id: string) {
  const [row] = await db().select().from(memories).where(eq(memories.id, id))
  return row!
}
/** A scratch memory-supersede conflict exactly as memory-resolve files one. */
async function conflict(kind: 'memory-supersede' | 'memory-contradict' = 'memory-supersede') {
  const existingId = await memory('existing')
  const newId = await memory('new')
  await db().insert(memoryRelations).values({ fromId: newId, toId: existingId, type: kind === 'memory-supersede' ? 'supersedes' : 'contradicts' })
  const row = await queueRow(kind, { newId, existingId, newContent: 'new', existingContent: 'old' }, 'memory', newId)
  return { row, newId, existingId }
}
async function relationStatus(newId: string, existingId: string) {
  const [r] = await db().select({ status: memoryRelations.status }).from(memoryRelations)
    .where(and(eq(memoryRelations.fromId, newId), eq(memoryRelations.toId, existingId)))
  return r!.status
}
const agentAction = () => queueRow('agent-action', { tool: 'get_job', args: { slug: `${TAG}no-such-job` }, conversationId })

const okJev = async (): Promise<JevVerdict> => ({ answers: { one_off: 0.1 }, risky: false, model: 'stub' })
const md = (slug: string, body: string, source: 'human' | 'agent') =>
  `---\nname: ${slug}\ndescription: Scratch skill\nwhen_to_use: When testing review decisions\nactive: false\nsource: ${source}\n---\n${body}\n`
/** A Tony-authored scratch skill plus a pending self-improvement edit of it (Tony's skill → review). */
async function improvement(label: string) {
  const slug = `${TAG}${label}`
  const s = await saveSkillSource(slug, md(slug, 'Original body.', 'human'), null, 'human')
  const r = await processProposal(
    { kind: 'skill.edit', target: slug, content: md(slug, 'Proposed body.', 'human'), reason: 'Tony asked for it', confidence: 0.9, evidence: ['always summarise the weekly report in three bullet points'] },
    { pass: 'thread', conversationId: null, runIds: [], input: '[user] please always summarise the weekly report in three bullet points', userInput: ['[user] please always summarise the weekly report in three bullet points'], expectedHash: s.contentHash },
    { jev: okJev }
  )
  improvementIds.push(r.improvementId)
  expect(r.status).toBe('pending_review')
  const [row] = await db().select().from(reviewQueue)
    .where(and(eq(reviewQueue.targetKind, 'improvement'), eq(reviewQueue.targetId, r.improvementId)))
  reviewIds.push(row!.id)
  return { slug, skill: s, row: row!, improvementId: r.improvementId }
}
async function improvementStatus(id: string) {
  const [row] = await db().select({ status: agentImprovements.status }).from(agentImprovements).where(eq(agentImprovements.id, id))
  return row!.status
}

beforeAll(async () => {
  ;[modeSnapshot] = await db().select().from(settings).where(eq(settings.key, SELF_IMPROVEMENT_MODE_KEY))
  await setSelfImprovementMode('on')
  const c = await createConversation({ title: `${TAG}thread` })
  conversationId = c.id
  convIds.push(c.id)
})

afterAll(async () => {
  if (improvementIds.length) {
    await db().delete(reviewQueue).where(and(eq(reviewQueue.targetKind, 'improvement'), inArray(reviewQueue.targetId, improvementIds)))
    await db().delete(agentConfigRevisions).where(inArray(agentConfigRevisions.improvementId, improvementIds))
    await db().delete(agentImprovements).where(inArray(agentImprovements.id, improvementIds))
  }
  if (reviewIds.length) await db().delete(reviewQueue).where(inArray(reviewQueue.id, reviewIds))
  if (memoryIds.length) {
    await db().delete(memoryRelations).where(inArray(memoryRelations.fromId, memoryIds))
    await db().delete(memories).where(inArray(memories.id, memoryIds))
  }
  const skillIds = (await db().select({ id: agentSkills.id }).from(agentSkills).where(like(agentSkills.slug, `${TAG}%`))).map(r => r.id)
  if (skillIds.length) {
    await db().delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'skill'), inArray(agentConfigRevisions.targetId, skillIds)))
    await db().delete(agentSkills).where(inArray(agentSkills.id, skillIds))
  }
  if (convIds.length) {
    await db().delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
    await db().delete(conversations).where(inArray(conversations.id, convIds))
  }
  if (modeSnapshot) await db().update(settings).set({ value: modeSnapshot.value, updatedAt: modeSnapshot.updatedAt }).where(eq(settings.key, SELF_IMPROVEMENT_MODE_KEY))
  else await db().delete(settings).where(eq(settings.key, SELF_IMPROVEMENT_MODE_KEY))

  expect(await db().select({ id: memories.id }).from(memories).where(like(memories.content, `${TAG}%`))).toHaveLength(0)
  expect(await db().select({ id: agentSkills.id }).from(agentSkills).where(like(agentSkills.slug, `${TAG}%`))).toHaveLength(0)
  expect(await db().select({ id: reviewQueue.id }).from(reviewQueue).where(inArray(reviewQueue.id, reviewIds.length ? reviewIds : [randomUUID()]))).toHaveLength(0)
})

describe('decideReview — generic kinds (agent-action)', () => {
  it('approve replays the stored call and marks the item approved, as the page does', async () => {
    const row = await agentAction()
    const r = await decideReview(row.id, 'approve')
    expect(r).toMatchObject({ ok: true })
    expect(await status(row.id)).toBe('approved')
    const msgs = await db().select().from(conversationMessages).where(eq(conversationMessages.conversationId, conversationId))
    expect(msgs.some(m => m.origin === 'review:approved' && m.content.startsWith('Approved: get_job'))).toBe(true)
  })

  it('reject runs nothing and marks the item rejected', async () => {
    const row = await agentAction()
    expect(await decideReview(row.id, 'reject')).toEqual({ ok: true, summary: 'Rejected.', undoToken: undefined, applied: undefined, result: undefined })
    expect(await status(row.id)).toBe('rejected')
  })

  it('a choice the item does not list → invalid_choice, nothing changes', async () => {
    const row = await agentAction()
    for (const choice of ['archive-old', 'keep', 'APPROVE']) {
      const r = await decideReview(row.id, choice)
      expect(r).toMatchObject({ ok: false, reason: 'invalid_choice' })
      expect((r as { message: string }).message).toContain('approve (Approve), reject (Reject)')
    }
    expect(await status(row.id)).toBe('pending')
  })

  it('a second decision → not_pending, and the first outcome stands (Review Focus 4)', async () => {
    const row = await agentAction()
    await decideReview(row.id, 'reject')
    expect(await decideReview(row.id, 'approve')).toMatchObject({ ok: false, reason: 'not_pending' })
    expect(await status(row.id)).toBe('rejected')
  })

  it('an unknown kind → unknown_kind, nothing changes', async () => {
    const row = await queueRow(`${TAG}mystery`, { anything: true })
    expect(await decideReview(row.id, 'approve')).toMatchObject({ ok: false, reason: 'unknown_kind', kind: `${TAG}mystery` })
    expect(await status(row.id)).toBe('pending')
  })

  it('an id that is nothing (or not a uuid) → not_pending', async () => {
    expect(await decideReview(randomUUID(), 'approve')).toMatchObject({ ok: false, reason: 'not_pending' })
    expect(await decideReview('not-a-uuid', 'approve')).toMatchObject({ ok: false, reason: 'not_pending' })
  })
})

describe('decideReview — memory conflicts', () => {
  it.each([
    ['keep-both', [], 'rejected'],
    ['archive-old', ['existing'], 'approved'],
    ['archive-new', ['new'], 'approved'],
    ['archive-both', ['existing', 'new'], 'approved']
  ] as const)('%s archives %j and marks the item %s', async (choice, archived, queueStatus) => {
    const c = await conflict()
    const r = await decideReview(c.row.id, choice)
    expect(r).toMatchObject({ ok: true })
    const ids = { existing: c.existingId, new: c.newId }
    expect(new Set((r as { applied: string[] }).applied)).toEqual(new Set(archived.map(k => ids[k])))
    for (const k of ['existing', 'new'] as const) {
      const m = await memoryRow(ids[k])
      expect(m.archivedAt !== null).toBe((archived as readonly string[]).includes(k))
    }
    // supersededBy only when one genuinely replaces the other (archivalPlan).
    if (choice === 'archive-old') expect((await memoryRow(c.existingId)).supersededBy).toBe(c.newId)
    if (choice === 'archive-new') expect((await memoryRow(c.newId)).supersededBy).toBe(c.existingId)
    if (choice === 'archive-both') expect((await memoryRow(c.newId)).supersededBy).toBeNull()
    expect(await relationStatus(c.newId, c.existingId)).toBe('resolved')
    expect(await status(c.row.id)).toBe(queueStatus)
  })

  it('page and Bridget deciding at once: the one that loses the race gets not_pending and archives nothing', async () => {
    // Deterministic race: hold the queue row locked, let decideReview read it as pending and block
    // on its claim, then "the page" decides (keep-both) and commits. decideReview's guarded claim
    // re-checks `status = 'pending'` after the lock is released — zero rows, so nothing is archived.
    const c = await conflict()
    let bridget!: Promise<Awaited<ReturnType<typeof decideReview>>>
    await db().transaction(async (tx) => {
      await tx.select({ id: reviewQueue.id }).from(reviewQueue).where(eq(reviewQueue.id, c.row.id)).for('update')
      bridget = decideReview(c.row.id, 'archive-both')
      await new Promise(r => setTimeout(r, 300))
      await tx.update(reviewQueue).set({ status: 'rejected', resolvedAt: new Date() }).where(eq(reviewQueue.id, c.row.id))
    })
    expect(await bridget).toMatchObject({ ok: false, reason: 'not_pending' })
    expect((await memoryRow(c.newId)).archivedAt).toBeNull()
    expect((await memoryRow(c.existingId)).archivedAt).toBeNull()
    expect(await relationStatus(c.newId, c.existingId)).toBe('active')
    expect(await status(c.row.id)).toBe('rejected')
  })

  it('a decision on a conflict already decided on the page → not_pending, nothing archived', async () => {
    const c = await conflict()
    expect(await callRoute(resolveRoute, c.row.id, { resolution: 'keep-both' })).toMatchObject({ ok: true })
    expect(await decideReview(c.row.id, 'archive-both')).toMatchObject({ ok: false, reason: 'not_pending' })
    expect((await memoryRow(c.newId)).archivedAt).toBeNull()
    expect((await memoryRow(c.existingId)).archivedAt).toBeNull()
    expect(await status(c.row.id)).toBe('rejected')
  })

  it('approve / reject are not conflict choices for the tool → invalid_choice, nothing archived', async () => {
    const c = await conflict('memory-contradict')
    expect(await decideReview(c.row.id, 'approve')).toMatchObject({ ok: false, reason: 'invalid_choice' })
    expect((await memoryRow(c.existingId)).archivedAt).toBeNull()
    expect(await relationStatus(c.newId, c.existingId)).toBe('active')
    expect(await status(c.row.id)).toBe('pending')
  })

  it('the routes keep their contract: POST approve on a conflict still archives the old one', async () => {
    const c = await conflict()
    expect(await callRoute(approveRoute, c.row.id)).toEqual({ ok: true, applied: undefined, undoToken: undefined, summary: undefined })
    expect((await memoryRow(c.existingId)).archivedAt).not.toBeNull()
    expect(await status(c.row.id)).toBe('approved')
  })

  it('resolve route: same effect as decideReview, same response shape and errors', async () => {
    const c = await conflict()
    expect(await callRoute(resolveRoute, c.row.id, { resolution: 'archive-new' })).toEqual({ ok: true, resolution: 'archive-new', archived: [c.newId] })
    expect((await memoryRow(c.newId)).archivedAt).not.toBeNull()
    expect(await callRoute(resolveRoute, c.row.id, { resolution: 'archive-new' })).toMatchObject({ thrown: { statusCode: 404 } })
    expect(await callRoute(resolveRoute, c.row.id, { resolution: 'nope' })).toMatchObject({ thrown: { statusCode: 400, statusMessage: 'Unknown resolution: nope' } })
    const aa = await agentAction()
    expect(await callRoute(resolveRoute, aa.id, { resolution: 'keep-both' })).toMatchObject({ thrown: { statusCode: 400, statusMessage: 'Not a memory conflict: agent-action' } })
    expect(await status(aa.id)).toBe('pending')
    const bad = await queueRow('memory-supersede', { newContent: 'x' }, 'memory')
    expect(await callRoute(resolveRoute, bad.id, { resolution: 'keep-both' })).toMatchObject({ thrown: { statusCode: 422 } })
  })
})

describe('decideReview — memory-unreviewed (memories.id)', () => {
  it('approve keeps it (reviewed_at stamped), as "Mark reviewed" does', async () => {
    const id = await memory('unreviewed-keep', false)
    expect(await decideReview(id, 'approve')).toMatchObject({ ok: true })
    const m = await memoryRow(id)
    expect(m.reviewedAt).not.toBeNull()
    expect(m.archivedAt).toBeNull()
    expect(await decideReview(id, 'reject')).toMatchObject({ ok: false, reason: 'not_pending' })
  })

  it('reject forgets it (archived, with an undo token), as "Discard" does', async () => {
    const id = await memory('unreviewed-forget', false)
    const r = await decideReview(id, 'reject')
    expect(r).toMatchObject({ ok: true })
    const token = (r as { undoToken?: string }).undoToken!
    expect(hasUndo(token)).toBe(true)
    expect((await memoryRow(id)).archivedAt).not.toBeNull()
    await runUndo(token)
    expect((await memoryRow(id)).archivedAt).toBeNull()
  })

  it('an invalid choice changes nothing; the routes never touch a memories.id', async () => {
    const id = await memory('unreviewed-invalid', false)
    expect(await decideReview(id, 'archive-old')).toMatchObject({ ok: false, reason: 'invalid_choice' })
    expect(await callRoute(approveRoute, id)).toMatchObject({ thrown: { statusCode: 404 } })
    expect(await callRoute(rejectRoute, id)).toMatchObject({ thrown: { statusCode: 404 } })
    const m = await memoryRow(id)
    expect(m.reviewedAt).toBeNull()
    expect(m.archivedAt).toBeNull()
  })
})

describe('decideReview — self-improvement', () => {
  it('approve applies the change through the store; the route reports the handler summary', async () => {
    const i = await improvement('approve')
    expect(await callRoute(approveRoute, i.row.id)).toEqual({ ok: true, applied: undefined, undoToken: undefined, summary: 'Improvement applied.' })
    expect((await getSkillSource(i.slug))!.content).toContain('Proposed body.')
    expect(await improvementStatus(i.improvementId)).toBe('applied')
    expect(await status(i.row.id)).toBe('approved')
  })

  it('reject records the rejection and leaves the skill alone', async () => {
    const i = await improvement('reject')
    expect(await decideReview(i.row.id, 'reject')).toMatchObject({ ok: true, summary: 'Rejected.' })
    expect(await improvementStatus(i.improvementId)).toBe('rejected')
    expect((await getSkillSource(i.slug))!.content).toBe(i.skill.content)
    expect(await status(i.row.id)).toBe('rejected')
  })

  it('Tony edited the skill since → conflict; nothing overwritten, the item stays pending and decidable', async () => {
    const i = await improvement('conflict')
    const tony = md(i.slug, 'Tony edited this.', 'human')
    await saveSkillSource(i.slug, tony, i.skill.contentHash, 'human')
    const r = await decideReview(i.row.id, 'approve')
    expect(r).toMatchObject({ ok: false, reason: 'conflict', current: { content: tony } })
    expect((await getSkillSource(i.slug))!.content).toBe(tony)
    expect(await status(i.row.id)).toBe('pending')
    expect(await improvementStatus(i.improvementId)).toBe('conflict')
    // `conflict` is not terminal: the refreshed item can still be decided.
    expect(await decideReview(i.row.id, 'reject')).toMatchObject({ ok: true })
    expect(await status(i.row.id)).toBe('rejected')
  })

  it('the approve route turns a conflict into the same 409 it always did', async () => {
    const i = await improvement('conflict-route')
    const tony = md(i.slug, 'Tony again.', 'human')
    await saveSkillSource(i.slug, tony, i.skill.contentHash, 'human')
    expect(await callRoute(approveRoute, i.row.id)).toMatchObject({
      thrown: { statusCode: 409, data: { current: { content: tony }, summary: 'Changed since proposed — reload the review' } }
    })
  })

  it('a non-conflict apply failure → apply_failed with the reason; nothing changes', async () => {
    const i = await improvement('broken')
    const [imp] = await db().select().from(agentImprovements).where(eq(agentImprovements.id, i.improvementId))
    // Break the stored proposal (our own row): content that is no longer a valid skill file.
    await db().update(agentImprovements).set({ proposal: { ...(imp!.proposal as object), content: 'no frontmatter at all' } })
      .where(eq(agentImprovements.id, i.improvementId))
    const r = await decideReview(i.row.id, 'approve')
    expect(r).toMatchObject({ ok: false, reason: 'apply_failed' })
    expect((r as { message: string }).message).toMatch(/^Could not apply: /)
    expect((await getSkillSource(i.slug))!.content).toBe(i.skill.content)
    expect(await status(i.row.id)).toBe('pending')
    expect(await callRoute(approveRoute, i.row.id)).toMatchObject({ thrown: { statusCode: 422 } })
  })
})

describe('listPendingReviews', () => {
  it('lists pending items with summary, detail and choices; decided ones drop out', async () => {
    const c = await conflict('memory-contradict')
    const i = await improvement('listed')
    const conflicts = await listPendingReviews({ kind: 'memory-contradict', limit: 50 })
    const mine = conflicts.find(x => x.id === c.row.id)!
    expect(mine.choices.map(x => x.label)).toEqual(['Keep both', 'Archive old', 'Archive new', 'Archive both'])
    expect(mine.detail).toMatchObject({ newContent: 'new', existingContent: 'old' })
    const imps = await listPendingReviews({ kind: 'self-improvement', limit: 50 })
    const listed = imps.find(x => x.id === i.row.id)!
    expect(listed.summary).toBe(`skill.edit ${i.slug}: Tony asked for it`)
    expect(listed.detail).toMatchObject({ target: i.slug, currentContent: i.skill.content, reviewReasons: expect.any(Array) })
    expect(listed.choices.map(x => x.id)).toEqual(['approve', 'reject'])

    await decideReview(i.row.id, 'reject')
    expect((await listPendingReviews({ kind: 'self-improvement', limit: 50 })).some(x => x.id === i.row.id)).toBe(false)
  })
})

describe('decide_review behind a denied confirmation', () => {
  it('the handler never runs: the real pending item is untouched', async () => {
    const i = await improvement('denied')
    const requestApproval = vi.fn().mockResolvedValue({ approved: false })
    const set = buildAiTools([decideReviewTool], { signal: new AbortController().signal, onEvent: () => {}, requestApproval })
    const res = await (set.decide_review as { execute: (a: unknown) => Promise<unknown> }).execute({ id: i.row.id, choice: 'approve' })
    expect(res).toEqual({ denied: true })
    expect(await status(i.row.id)).toBe('pending')
    expect(await improvementStatus(i.improvementId)).toBe('pending_review')
    expect((await getSkillSource(i.slug))!.content).toBe(i.skill.content)
  })
})
