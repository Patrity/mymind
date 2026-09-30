// test/reflect-passes.db.test.ts
//
// DB-backed — cycle 76, Task 7: runThreadPass / runJobsPass through their seams
// (onlyConversationIds / onlyJobSlugs), with a stubbed chatFn returning fixed JSON and a stubbed
// Jev. The dev DB is SHARED with real data: scratch conversations, `simp-<run>-` skills/jobs and
// their signals are created and deleted here; the profile singleton and the settings rows the
// passes can touch (self_improvement_mode, signals_started_at) are snapshotted and restored. The
// last test proves nothing outside the seams moved.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { and, eq, inArray, like, notInArray, or, sql } from 'drizzle-orm'
import { useDb } from '../server/db'
import {
  agentConfigRevisions, agentImprovements, agentJobs, agentProfile, agentSignals, agentSkills, conversationMessages,
  conversations, reviewQueue, settings, type AgentProfileRow
} from '../server/db/schema'
import { createConversation } from '../server/services/conversations'
import { getSkillSource } from '../server/services/skills'
import { createJob } from '../server/lib/agent/jobs/store'
import { SELF_IMPROVEMENT_MODE_KEY, setSelfImprovementMode } from '../server/lib/agent/self-improvement-mode'
import { SIGNALS_STARTED_AT_KEY } from '../server/lib/agent/signals/write'
import { runThreadPass } from '../server/lib/agent/reflect/thread-pass'
import { runJobsPass } from '../server/lib/agent/reflect/jobs-pass'
import type { JevVerdict } from '../server/lib/agent/reflect/jev'
import type { ChatMessage } from '../server/lib/ai/chat'

const db = () => useDb()
const TAG = `simp-${Date.now().toString(36)}-`
const NOW = new Date()
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)
const md = (fm: string, body: string) => `---\n${fm}\n---\n${body}\n`
const jobMd = (body: string) => md('trigger: at 2100-01-01T09:00:00Z\nenabled: true', body)
const jev = async (): Promise<JevVerdict> => ({ answers: {}, risky: false, model: 'stub' })

const QUOTE = 'when I say ship it, run the tests before you commit anything'
const convIds: string[] = []
const settingKeys = [SELF_IMPROVEMENT_MODE_KEY, SIGNALS_STARTED_AT_KEY]
let settingsSnapshot: (typeof settings.$inferSelect)[] = []
let profileSnapshot: AgentProfileRow | null = null
let profileRevisionIds: string[] = []
let outside: { watermarks: string; improvements: number; signals: number; reviews: number } | null = null

/** Outside-the-seams fingerprint: real threads' watermarks, real improvements/signals/review rows. */
async function outsideFingerprint() {
  const [w] = (await db().execute(sql`select count(*)::int as n, coalesce(max(reflected_through)::text, '') as m
    from conversations where reflected_through is not null
    ${convIds.length ? sql`and id not in (${sql.join(convIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql``}`)).rows as { n: number; m: string }[]
  const mine = await myImprovementIds()
  const [imp] = await db().select({ n: sql<number>`count(*)::int` }).from(agentImprovements)
    .where(mine.length ? notInArray(agentImprovements.id, mine) : undefined)
  const jobIds = await myJobIds()
  const [sig] = await db().select({ n: sql<number>`count(*)::int` }).from(agentSignals)
    .where(jobIds.length ? or(notInArray(agentSignals.jobId, jobIds), sql`${agentSignals.jobId} is null`) : undefined)
  const [rev] = await db().select({ n: sql<number>`count(*)::int` }).from(reviewQueue)
    .where(mine.length ? notInArray(reviewQueue.targetId, mine) : undefined)
  return { watermarks: `${w!.n}/${w!.m}`, improvements: imp!.n, signals: sig!.n, reviews: rev!.n }
}

async function myJobIds() {
  return (await db().select({ id: agentJobs.id }).from(agentJobs).where(like(agentJobs.slug, `${TAG}%`))).map(r => r.id)
}
async function myImprovementIds() {
  return (await db().select({ id: agentImprovements.id }).from(agentImprovements).where(or(
    like(agentImprovements.target, `${TAG}%`),
    convIds.length ? inArray(agentImprovements.sourceConversationId, convIds) : undefined
  ))).map(r => r.id)
}

/** A settled scratch thread: 4 turns, the last 40 min ago, never reflected. */
async function scratchThread(userText = `Remember: ${QUOTE}.`) {
  const c = await createConversation({ title: `${TAG}thread` }); convIds.push(c.id)
  const turns = [
    { role: 'user', content: userText, at: minAgo(70) },
    { role: 'assistant', content: 'Understood.', at: minAgo(60) },
    { role: 'user', content: 'Thanks.', at: minAgo(50) },
    { role: 'assistant', content: 'Any time.', at: minAgo(40) }
  ]
  await db().insert(conversationMessages).values(turns.map(t => ({
    conversationId: c.id, role: t.role, content: t.content, modality: 'text', createdAt: t.at
  })))
  await db().update(conversations).set({ messageCount: turns.length, lastMessageAt: minAgo(40) }).where(eq(conversations.id, c.id))
  return { id: c.id, lastAt: minAgo(40) }
}
async function watermark(id: string) {
  const [row] = await db().select({ r: conversations.reflectedThrough }).from(conversations).where(eq(conversations.id, id))
  return row!.r
}

beforeAll(async () => {
  settingsSnapshot = await db().select().from(settings).where(inArray(settings.key, settingKeys))
  ;[profileSnapshot] = await db().select().from(agentProfile)
  profileRevisionIds = (await db().select({ id: agentConfigRevisions.id }).from(agentConfigRevisions)
    .where(eq(agentConfigRevisions.targetKind, 'profile'))).map(r => r.id)
  outside = await outsideFingerprint()
  await setSelfImprovementMode('on')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterAll(async () => {
  const imps = await myImprovementIds()
  if (imps.length) {
    await db().delete(reviewQueue).where(and(eq(reviewQueue.targetKind, 'improvement'), inArray(reviewQueue.targetId, imps)))
    await db().delete(agentImprovements).where(inArray(agentImprovements.id, imps))
  }
  const skillIds = (await db().select({ id: agentSkills.id }).from(agentSkills).where(like(agentSkills.slug, `${TAG}%`))).map(r => r.id)
  if (skillIds.length) {
    await db().delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'skill'), inArray(agentConfigRevisions.targetId, skillIds)))
    await db().delete(agentSkills).where(inArray(agentSkills.id, skillIds))
  }
  const jobIds = await myJobIds()
  if (jobIds.length) {
    await db().delete(agentSignals).where(inArray(agentSignals.jobId, jobIds))
    await db().delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, jobIds)))
    await db().delete(agentJobs).where(inArray(agentJobs.id, jobIds))
  }
  if (convIds.length) {
    await db().delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
    await db().delete(conversations).where(inArray(conversations.id, convIds))
  }
  const profRevs = (await db().select({ id: agentConfigRevisions.id }).from(agentConfigRevisions)
    .where(eq(agentConfigRevisions.targetKind, 'profile'))).map(r => r.id).filter(id => !profileRevisionIds.includes(id))
  if (profRevs.length) await db().delete(agentConfigRevisions).where(inArray(agentConfigRevisions.id, profRevs))
  if (profileSnapshot) {
    await db().update(agentProfile).set({
      content: profileSnapshot.content, contentHash: profileSnapshot.contentHash,
      updatedBy: profileSnapshot.updatedBy, updatedAt: profileSnapshot.updatedAt
    }).where(eq(agentProfile.id, profileSnapshot.id))
  } else {
    await db().delete(agentProfile)
  }
  for (const key of settingKeys) {
    const snap = settingsSnapshot.find(s => s.key === key)
    if (snap) await db().update(settings).set({ value: snap.value, updatedAt: snap.updatedAt }).where(eq(settings.key, key))
    else await db().delete(settings).where(eq(settings.key, key))
  }
  vi.restoreAllMocks()
  expect(await db().select({ id: conversations.id }).from(conversations).where(like(conversations.title, `${TAG}%`))).toHaveLength(0)
  expect(await myJobIds()).toHaveLength(0)
})

describe('runThreadPass', () => {
  it('advances the watermark on zero proposals', async () => {
    const t = await scratchThread()
    const chatFn = vi.fn(async () => '{"proposals": []}')
    expect(await runThreadPass({ now: NOW, onlyConversationIds: [t.id], chatFn, jev })).toEqual({ threads: 1, proposals: 0 })
    expect(chatFn).toHaveBeenCalledTimes(1)
    expect((await watermark(t.id))!.getTime()).toBe(t.lastAt.getTime())
  })

  it('on success routes proposals with the thread as evidence, then advances the watermark', async () => {
    const t = await scratchThread()
    const slug = `${TAG}ship-it`
    const skill = md(`name: ${slug}\ndescription: Ship it means test first\nwhen_to_use: When Tony says ship it\nactive: false`, 'Run the tests, then commit.')
    let seen: ChatMessage[] = []
    const chatFn = vi.fn(async (_role: string, messages: ChatMessage[]) => {
      seen = messages
      return JSON.stringify({ proposals: [
        { kind: 'skill.create', target: slug, content: skill, reason: 'Tony stated a procedure', confidence: 0.8, evidence: [QUOTE] },
        // Quotes the prompt's rules, not the transcript: dropped on evidence.
        { kind: 'skill.create', target: `${TAG}bogus`, content: skill.replaceAll(slug, `${TAG}bogus`), reason: 'x', confidence: 0.5, evidence: ['Output JSON only: {"proposals": [...]}'] }
      ] })
    })
    expect(await runThreadPass({ now: NOW, onlyConversationIds: [t.id], chatFn: chatFn as never, jev })).toEqual({ threads: 1, proposals: 2 })
    expect(seen.map(m => m.content).join('\n')).toContain(`[user] Remember: ${QUOTE}.`)

    expect((await getSkillSource(slug))?.source).toBe('agent')
    const rows = await db().select().from(agentImprovements).where(eq(agentImprovements.sourceConversationId, t.id))
    expect(rows.map(r => [r.target, r.status, r.dropReason]).sort()).toEqual([
      [slug, 'applied', null],
      [`${TAG}bogus`, 'dropped', 'evidence']
    ].sort())
    expect(rows.every(r => r.pass === 'thread')).toBe(true)
    expect(await getSkillSource(`${TAG}bogus`)).toBeNull()
    expect((await watermark(t.id))!.getTime()).toBe(t.lastAt.getTime())
  })

  it('retries once after a chatFn failure, then advances with no proposals', async () => {
    const t = await scratchThread()
    const chatFn = vi.fn(async (): Promise<string> => { throw new Error('model down') })
    expect(await runThreadPass({ now: NOW, onlyConversationIds: [t.id], chatFn, jev })).toEqual({ threads: 1, proposals: 0 })
    expect(await watermark(t.id)).toBeNull()

    expect(await runThreadPass({ now: NOW, onlyConversationIds: [t.id], chatFn, jev })).toEqual({ threads: 1, proposals: 0 })
    expect(chatFn).toHaveBeenCalledTimes(2)
    expect((await watermark(t.id))!.getTime()).toBe(t.lastAt.getTime())
    expect(await db().select().from(agentImprovements).where(eq(agentImprovements.sourceConversationId, t.id))).toHaveLength(0)
  })

  it('an unparseable reply counts as a failure too; a good retry clears it', async () => {
    const t = await scratchThread()
    const replies = ['Sure! Here are my thoughts', '{"proposals": []}']
    const chatFn = vi.fn(async () => replies.shift()!)
    await runThreadPass({ now: NOW, onlyConversationIds: [t.id], chatFn, jev })
    expect(await watermark(t.id)).toBeNull()
    await runThreadPass({ now: NOW, onlyConversationIds: [t.id], chatFn, jev })
    expect(chatFn).toHaveBeenCalledTimes(2)
    expect((await watermark(t.id))!.getTime()).toBe(t.lastAt.getTime())
  })

  it('does nothing when self-improvement is off', async () => {
    const t = await scratchThread()
    const chatFn = vi.fn(async () => '{"proposals": []}')
    await setSelfImprovementMode('off')
    try {
      expect(await runThreadPass({ now: NOW, onlyConversationIds: [t.id], chatFn, jev })).toEqual({ threads: 0, proposals: 0 })
    } finally {
      await setSelfImprovementMode('on')
    }
    expect(chatFn).not.toHaveBeenCalled()
    expect(await watermark(t.id)).toBeNull()
  })
})

describe('runJobsPass', () => {
  it('skips a job with 4 signals and processes one with 5', async () => {
    const four = await createJob({ slug: `${TAG}four`, content: jobMd('Four signals.'), actor: 'human' })
    const five = await createJob({ slug: `${TAG}five`, content: jobMd('Five signals.'), actor: 'human' })
    const other = await createJob({ slug: `${TAG}other`, content: jobMd('Another eligible job.'), actor: 'human' })
    const at = new Date(NOW.getTime() - 3600_000)
    const signal = (jobId: string, i: number, detail: string | null) => ({ jobId, kind: i % 2 ? 'ignored' : 'replied', detail, createdAt: at })
    await db().insert(agentSignals).values([
      ...Array.from({ length: 4 }, (_, i) => signal(four.id, i, i ? null : 'four job reply that is long enough')),
      ...Array.from({ length: 5 }, (_, i) => signal(five.id, i, i ? null : 'please stop sending me this every morning')),
      ...Array.from({ length: 5 }, (_, i) => signal(other.id, i, i ? null : 'the other job is actually useful'))
    ])

    let prompt = ''
    const chatFn = vi.fn(async (_role: string, messages: ChatMessage[]) => {
      prompt = messages.map(m => m.content).join('\n')
      return JSON.stringify({ proposals: [
        { kind: 'job.disable', target: five.slug, reason: 'Tony asked to stop', confidence: 0.9, evidence: ['please stop sending me this every morning'] },
        // A job the pass skipped has no evidence source.
        { kind: 'job.disable', target: four.slug, reason: 'x', confidence: 0.5, evidence: ['four job reply that is long enough'] },
        // Evidence from another job's snippets is not evidence for this one.
        { kind: 'job.disable', target: other.slug, reason: 'y', confidence: 0.5, evidence: ['please stop sending me this every morning'] }
      ] })
    })
    expect(await runJobsPass({ now: NOW, onlyJobSlugs: [four.slug, five.slug, other.slug], chatFn: chatFn as never, jev })).toEqual({ jobs: 2, proposals: 3 })
    expect(chatFn).toHaveBeenCalledTimes(1)
    expect(prompt).toContain(`## Job ${five.slug}`)
    expect(prompt).not.toContain(four.slug)
    expect(prompt).toContain('replied: 3, ignored: 2')

    const rows = await db().select().from(agentImprovements).where(like(agentImprovements.target, `${TAG}%`))
    const byTarget = Object.fromEntries(rows.filter(r => r.pass === 'jobs').map(r => [r.target, r]))
    expect(byTarget[five.slug]).toMatchObject({ kind: 'job.disable', status: 'pending_review', route: 'review' })
    expect(byTarget[four.slug]).toMatchObject({ status: 'dropped', dropReason: 'evidence' })
    expect(byTarget[other.slug]).toMatchObject({ status: 'dropped', dropReason: 'evidence' })
  })

  it('makes no model call when no job has enough signals', async () => {
    const quiet = await createJob({ slug: `${TAG}quiet`, content: jobMd('Quiet.'), actor: 'human' })
    const chatFn = vi.fn(async () => '{"proposals": []}')
    expect(await runJobsPass({ now: NOW, onlyJobSlugs: [quiet.slug], chatFn, jev })).toEqual({ jobs: 0, proposals: 0 })
    expect(chatFn).not.toHaveBeenCalled()
  })
})

describe('seams', () => {
  it('nothing outside the seams moved', async () => {
    // Real threads' watermarks, and every improvement, signal and review row not created here.
    expect(await outsideFingerprint()).toEqual(outside)
  })
})
