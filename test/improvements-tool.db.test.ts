// test/improvements-tool.db.test.ts
//
// DB-backed — cycle 76, Task 10: list_improvements (the reflector's read-only log), the
// self-improvement-digest seed job, and the "learned" badge's data (revisions carrying
// improvementId/sourceConversationId). The dev DB is SHARED with real data:
//   - every agent_improvements row this file writes is a scratch row with a `limpt-<run>-`
//     target/reason, collected by id and deleted in afterAll;
//   - the `pendingReview` count is asserted as a DELTA against a baseline read before this file's
//     scratch rows exist, never as an absolute number (real pending items may already be there);
//   - the scratch skill used to prove the badge is `active: false` and deleted (with its
//     revisions) in afterAll;
//   - self-improvement-digest itself is a REAL seed job (spec-mandated, installed disabled) —
//     this file installs it for real (idempotent, like the other four) and does NOT delete it.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { useDb } from '../server/db'
import { agentImprovements, agentConfigRevisions, agentSkills, type AgentImprovementRow } from '../server/db/schema'
import { listImprovementsTool, listImprovementsSince } from '../server/lib/agent/tools/improvements'
import { agentTools } from '../server/lib/agent/tools'
import { bridgetProfile } from '../server/lib/agent/profile'
import { mcpToolNames } from '../server/lib/mcp/server'
import { classifyForHeadless } from '../server/lib/agent/runtime/gate'
import { SEED_JOB_SLUGS, SEED_JOBS, SEED_JOBS_V1_SLUGS } from '../server/lib/agent/jobs/seeds'
import { installSeedJobs, getJob } from '../server/lib/agent/jobs/store'
import { parseJob } from '../server/lib/agent/jobs/parse'
import { getDefaultTimezone } from '../server/lib/agent/jobs/timezone'
import { createSkill, deleteSkill, getSkillSource, saveSkillSource, listSkillRevisions } from '../server/services/skills'

const ctx = { signal: new AbortController().signal }
const TAG = `limpt-${Date.now().toString(36)}-`

const improvementIds: string[] = []

async function insertImprovement(row: {
  kind: string, target: string, status: AgentImprovementRow['status'], reason: string,
  createdAt?: Date, revisionId?: string | null, sourceConversationId?: string | null
}): Promise<AgentImprovementRow> {
  const [r] = await useDb().insert(agentImprovements).values({
    pass: 'thread',
    sourceConversationId: row.sourceConversationId ?? null,
    kind: row.kind,
    target: row.target,
    proposal: { reason: row.reason },
    route: row.status === 'dropped' ? 'dropped' : row.status === 'applied' ? 'auto' : 'review',
    status: row.status,
    revisionId: row.revisionId ?? null,
    createdAt: row.createdAt ?? new Date(),
    decidedAt: row.status === 'applied' || row.status === 'rejected' || row.status === 'dropped' ? (row.createdAt ?? new Date()) : null
  }).returning()
  improvementIds.push(r!.id)
  return r!
}

async function pendingReviewNow(): Promise<number> {
  const { pendingReview } = await listImprovementsSince({ limit: 1 })
  return pendingReview
}

afterAll(async () => {
  if (improvementIds.length) await useDb().delete(agentImprovements).where(inArray(agentImprovements.id, improvementIds))
})

describe('list_improvements — tool wiring', () => {
  it('is read-class: in agentTools, on the Bridget profile, on MCP, and runs in a headless run', () => {
    expect(listImprovementsTool.kind).toBe('read')
    expect(agentTools).toContain(listImprovementsTool)
    expect(bridgetProfile.tools).toContain(listImprovementsTool)
    expect(mcpToolNames()).toContain('list_improvements')
    expect(classifyForHeadless(listImprovementsTool)).toBe('run')
  })
})

describe('list_improvements — items, links, pending count', () => {
  it('returns rows scoped by `since`, newest first, honours `limit`, and computes the right link per kind/status', async () => {
    // Far in the future: nothing real on the shared dev DB can possibly land here, so these
    // scratch rows can never be pushed off the page by real traffic, whatever `limit` is.
    const base = new Date('2099-06-01T12:00:00Z')
    const applied = await insertImprovement({
      kind: 'skill.edit', target: `${TAG}skill`, status: 'applied', reason: 'Tony asked for bullets',
      createdAt: new Date(base.getTime() + 1000), revisionId: randomUUID()
    })
    const appliedJob = await insertImprovement({
      kind: 'job.disable', target: `${TAG}job`, status: 'applied', reason: 'job never fires',
      createdAt: new Date(base.getTime() + 2000), revisionId: randomUUID()
    })
    const appliedProfile = await insertImprovement({
      kind: 'profile.edit', target: 'profile', status: 'applied', reason: 'Tony prefers short answers',
      createdAt: new Date(base.getTime() + 3000), revisionId: randomUUID()
    })
    const pending = await insertImprovement({
      kind: 'job.edit', target: `${TAG}job2`, status: 'pending_review', reason: 'changes enabled',
      createdAt: new Date(base.getTime() + 4000)
    })
    const conflict = await insertImprovement({
      kind: 'skill.create', target: `${TAG}skill2`, status: 'conflict', reason: 'edited underneath',
      createdAt: new Date(base.getTime() + 5000)
    })
    const rejected = await insertImprovement({
      kind: 'skill.edit', target: `${TAG}skill3`, status: 'rejected', reason: 'not wanted',
      createdAt: new Date(base.getTime() + 6000)
    })
    const dropped = await insertImprovement({
      kind: 'job.disable', target: `${TAG}job3`, status: 'dropped', reason: 'low evidence',
      createdAt: new Date(base.getTime() + 7000)
    })
    // Well before `since` below — must never appear.
    await insertImprovement({
      kind: 'skill.edit', target: `${TAG}old`, status: 'applied', reason: 'too old', createdAt: new Date(base.getTime() - 3600_000)
    })

    const { result } = await listImprovementsTool.handler({ since: base.toISOString(), limit: 30 }, ctx)
    const items = (result as { items: { id: string, kind: string, target: string, status: string, reason: string, revisionId: string | null, createdAt: string, link: string | null }[], pendingReview: number }).items

    const ids = [applied, appliedJob, appliedProfile, pending, conflict, rejected, dropped].map(r => r.id)
    expect(items.filter(i => ids.includes(i.id)).map(i => i.id)).toEqual([...ids].reverse()) // newest first

    const byId = new Map(items.map(i => [i.id, i]))
    expect(byId.get(applied.id)).toMatchObject({ kind: 'skill.edit', target: `${TAG}skill`, status: 'applied', reason: 'Tony asked for bullets', revisionId: applied.revisionId, link: `/skills/${TAG}skill` })
    expect(byId.get(appliedJob.id)).toMatchObject({ status: 'applied', link: `/jobs/${TAG}job` })
    expect(byId.get(appliedProfile.id)).toMatchObject({ status: 'applied', link: '/settings/profile' })
    expect(byId.get(pending.id)).toMatchObject({ status: 'pending_review', link: '/review' })
    // conflict is NOT terminal — still linked to /review, not treated like a dead end.
    expect(byId.get(conflict.id)).toMatchObject({ status: 'conflict', link: '/review' })
    expect(byId.get(rejected.id)).toMatchObject({ status: 'rejected', link: null })
    expect(byId.get(dropped.id)).toMatchObject({ status: 'dropped', link: null })

    const limited = await listImprovementsTool.handler({ since: base.toISOString(), limit: 2 }, ctx)
    expect((limited.result as { items: unknown[] }).items).toHaveLength(2)
  })

  it('`pendingReview` counts pending_review AND conflict, live, independent of `since`', async () => {
    const before = await pendingReviewNow()
    const t = new Date('2020-01-01T00:00:00Z') // ancient — outside any `since` window used elsewhere
    await insertImprovement({ kind: 'skill.edit', target: `${TAG}p1`, status: 'pending_review', reason: 'r', createdAt: t })
    await insertImprovement({ kind: 'job.edit', target: `${TAG}p2`, status: 'conflict', reason: 'r', createdAt: t })
    await insertImprovement({ kind: 'skill.edit', target: `${TAG}p3`, status: 'applied', reason: 'r', createdAt: t, revisionId: randomUUID() })

    const after = await pendingReviewNow()
    expect(after).toBe(before + 2)

    // A `since` far in the future would exclude every item from the log — pendingReview is
    // unaffected either way, because it is never scoped by `since`.
    const { pendingReview } = (await listImprovementsTool.handler({ since: '2099-01-01T00:00:00Z', limit: 1 }, ctx)).result as { items: unknown[], pendingReview: number }
    expect(pendingReview).toBe(after)
  })

  it('defaults `since` to the start of today in the agent timezone: excludes a row from well over a day ago, includes one from just now', async () => {
    const tz = await getDefaultTimezone()
    expect(typeof tz).toBe('string')
    const longAgo = await insertImprovement({
      kind: 'skill.edit', target: `${TAG}yesterday`, status: 'applied', reason: 'r',
      createdAt: new Date(Date.now() - 30 * 3600_000), revisionId: randomUUID()
    })
    const justNow = await insertImprovement({
      kind: 'skill.edit', target: `${TAG}justnow`, status: 'applied', reason: 'r',
      createdAt: new Date(), revisionId: randomUUID()
    })

    const { result } = await listImprovementsTool.handler({ limit: 100 }, ctx)
    const ids = (result as { items: { id: string }[] }).items.map(i => i.id)
    expect(ids).toContain(justNow.id)
    expect(ids).not.toContain(longAgo.id)
  })

  it('never throws — an invalid `since` falls back gracefully rather than rejecting the call', async () => {
    const { result } = await listImprovementsTool.handler({ since: 'not-a-date', limit: 5 }, ctx)
    expect((result as { items: unknown[] }).items).toBeDefined()
  })
})

describe('self-improvement-digest seed', () => {
  it('parses, is disabled, and calls for list_improvements + NO_REPLY + /review, per spec verbatim', () => {
    const content = SEED_JOBS['self-improvement-digest']
    expect(content).toBe(`---
trigger: cron 30 21 * * *
context: light
deliver: [auto]
enabled: false
---
Call list_improvements for today. If there are no applied changes and nothing pending review, reply NO_REPLY.
Otherwise give Tony a short digest: each change you made to yourself today (one line, with its link so he can undo it), then how many proposals are waiting in /review.
`)
    const result = parseJob(content, { defaultTimezone: 'America/Chicago' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.spec.enabled).toBe(false)
    expect(result.spec.deliver).toEqual(['auto'])
    expect(result.spec.trigger).toEqual({ kind: 'cron', expr: '30 21 * * *' })
  })

  it('is in SEED_JOB_SLUGS but not in the V1 (upgrade) set', () => {
    expect(SEED_JOB_SLUGS).toContain('self-improvement-digest')
    expect(SEED_JOBS_V1_SLUGS).not.toContain('self-improvement-digest')
  })

  it('installSeedJobs installs it once, disabled, as a REAL seed (not cleaned up)', async () => {
    const before = await Promise.all(SEED_JOB_SLUGS.map(async slug => [slug, await getJob(slug)] as const))
    const beforeCount = before.filter(([, j]) => j !== null).length

    await installSeedJobs()
    const again = await installSeedJobs() // idempotent: nothing left to install the second time
    expect(again).toBe(0)

    const after = await Promise.all(SEED_JOB_SLUGS.map(async slug => [slug, await getJob(slug)] as const))
    expect(after.every(([, j]) => j !== null)).toBe(true)
    expect(after).toHaveLength(5)
    const digest = after.find(([slug]) => slug === 'self-improvement-digest')![1]!
    expect(digest.enabled).toBe(false)
    expect(digest.content).toBe(SEED_JOBS['self-improvement-digest'])
    expect(digest.parseError).toBeNull()

    // The four pre-existing seeds are unchanged by this run (already installed on the shared dev
    // DB from a real boot; installSeedJobs skips any slug that already exists).
    for (const slug of SEED_JOBS_V1_SLUGS) {
      const [, j] = after.find(([s]) => s === slug)!
      expect(j).not.toBeNull()
    }
    expect(beforeCount).toBeGreaterThanOrEqual(4) // the original four were already there
  })
})

describe('revisions carry improvementId + sourceConversationId (the "learned" badge\'s data)', () => {
  const skillSlug = `${TAG}badge-skill`
  const skillMd = (body: string) => `---\nname: ${skillSlug}\ndescription: Scratch skill for the learned-badge test.\nwhen_to_use: Never — test only.\nactive: false\nsource: agent\n---\n${body}\n`
  // Captured at creation, not re-derived via getSkillSource in afterAll: the test below hard-
  // deletes the skill itself (deleteSkill), so a lookup-then-clean afterAll would find nothing
  // and skip its own cleanup, orphaning this skill's revisions (they carry no FK and survive).
  let skillId: string | null = null

  afterAll(async () => {
    if (!skillId) return
    await useDb().delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'skill'), eq(agentConfigRevisions.targetId, skillId)))
    await useDb().delete(agentSkills).where(eq(agentSkills.id, skillId))
  })

  it('a revision written with an improvementId comes back from listSkillRevisions with its sourceConversationId', async () => {
    const created = await createSkill({ name: skillSlug, description: 'Scratch skill for the learned-badge test.', whenToUse: 'Never — test only.', body: 'Original body.', active: false, source: 'agent' })
    skillId = created.id
    const conversationId = randomUUID()
    const improvement = await insertImprovement({
      kind: 'skill.edit', target: skillSlug, status: 'applied', reason: 'Tony asked for bullets', sourceConversationId: conversationId
    })
    const updated = await saveSkillSource(skillSlug, skillMd('Learned body.'), (await getSkillSource(skillSlug))!.contentHash, 'agent', { improvementId: improvement.id })
    expect(updated.content).toContain('Learned body.')

    const revs = await listSkillRevisions(skillSlug)
    const learned = revs.find(r => r.content.includes('Learned body.'))
    expect(learned).toMatchObject({ improvementId: improvement.id, sourceConversationId: conversationId })
    const original = revs.find(r => r.content.includes('Original body.'))
    expect(original).toMatchObject({ improvementId: null, sourceConversationId: null })

    // deleteSkill hard-deletes the row but records a final revision first (recordRevision), which
    // also survives with no FK — swept by this describe's afterAll along with the other two.
    await deleteSkill(skillSlug, { actor: 'agent' })
    expect(await getSkillSource(skillSlug)).toBeNull()
  })
})
