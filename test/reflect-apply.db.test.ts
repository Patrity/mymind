// test/reflect-apply.db.test.ts
//
// DB-backed — cycle 76, Task 7: processProposal / applyImprovement and the `self-improvement`
// review kind. The dev DB is SHARED with real data:
//   - every skill/job this file writes has a `simp-<run>-` slug and is deleted (with its revisions)
//     in afterAll; scratch skills are `active: false`, scratch jobs are `at` 2100 (never fire);
//   - improvements and review rows are collected by id and deleted;
//   - the profile singleton and the self_improvement_mode setting are snapshotted and restored.
// Jev is always a stub; no model is called.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
vi.stubGlobal('createError', (o: { statusCode: number, message?: string }) => Object.assign(new Error(o.message ?? 'err'), o))

import { randomUUID } from 'node:crypto'
import { and, eq, inArray, like } from 'drizzle-orm'
import { useDb } from '../server/db'
import {
  agentConfigRevisions, agentImprovements, agentJobs, agentProfile, agentSkills, reviewQueue, settings,
  type AgentProfileRow, type ReviewItem
} from '../server/db/schema'
import { getSkillSource, parseSkillMarkdown, saveSkillSource } from '../server/services/skills'
import { getProfileSource } from '../server/services/profile'
import { createJob, deleteJob, getJob } from '../server/lib/agent/jobs/store'
import { SELF_IMPROVEMENT_MODE_KEY, setSelfImprovementMode } from '../server/lib/agent/self-improvement-mode'
import { processProposal, countAutoAppliedToday, type ProposalSource, type StoredProposal } from '../server/lib/agent/reflect/apply'
import type { JevVerdict } from '../server/lib/agent/reflect/jev'
import type { Proposal } from '../server/lib/agent/reflect/schema'
import { approveHandlers, rejectHandlers, SELF_IMPROVEMENT_CONFLICT } from '../server/api/review/kinds'

const db = () => useDb()
const TAG = `simp-${Date.now().toString(36)}-`
const md = (fm: string, body: string) => `---\n${fm}\n---\n${body}\n`
const skillMd = (name: string, body: string, source: 'human' | 'agent' = 'agent') =>
  md(`name: ${name}\ndescription: Scratch skill\nwhen_to_use: When testing reflection\nactive: false\nsource: ${source}`, body)
const jobMd = (body: string) => md('trigger: at 2100-01-01T09:00:00Z\nenabled: true', body)

const TRANSCRIPT = '[user] please always summarise the weekly report in three bullet points\n[bridget] Will do.'
const EVIDENCE = ['always summarise the weekly report in three bullet points']
const okJev = async (): Promise<JevVerdict> => ({ answers: { one_off: 0.1 }, risky: false, model: 'stub' })

const improvementIds: string[] = []
/** Jobs a test deleted: their revisions outlive them and are removed by id. */
const deletedJobIds: string[] = []
let modeSnapshot: typeof settings.$inferSelect | null = null
let profileSnapshot: AgentProfileRow | null = null
let profileRevisionIds: string[] = []

function proposal(kind: Proposal['kind'], target: string, content?: string, reason = 'Tony asked for it'): Proposal {
  return { kind, target, content, reason, confidence: 0.9, evidence: EVIDENCE }
}
const src = (expectedHash: string | null, over: Partial<ProposalSource> = {}): ProposalSource =>
  ({ pass: 'thread', conversationId: null, runIds: [], input: TRANSCRIPT, userInput: [TRANSCRIPT], expectedHash, ...over })

async function run(p: Proposal, s: ProposalSource, jev: typeof okJev = okJev) {
  const r = await processProposal(p, s, { jev })
  improvementIds.push(r.improvementId)
  return r
}
async function improvement(id: string) {
  const [row] = await db().select().from(agentImprovements).where(eq(agentImprovements.id, id))
  return row!
}
async function reviewItem(improvementId: string): Promise<ReviewItem | undefined> {
  const [row] = await db().select().from(reviewQueue)
    .where(and(eq(reviewQueue.targetKind, 'improvement'), eq(reviewQueue.targetId, improvementId)))
  return row
}
async function revisionsFor(improvementId: string) {
  return db().select().from(agentConfigRevisions).where(eq(agentConfigRevisions.improvementId, improvementId))
}
/** A scratch job whose revisions are backdated 2 days, so the 24 h change cap doesn't apply. */
async function oldJob(slug: string, source: 'human' | 'agent', enabled = true, body = 'Scratch job body.') {
  const j = await createJob({ slug, content: md(`trigger: at 2100-01-01T09:00:00Z\nenabled: ${enabled}`, body), actor: source })
  await db().update(agentConfigRevisions).set({ createdAt: new Date(Date.now() - 2 * 24 * 3600_000) })
    .where(and(eq(agentConfigRevisions.targetKind, 'job'), eq(agentConfigRevisions.targetId, j.id)))
  return j
}
/** A scratch skill whose revisions are backdated 2 days, so the 24 h change cap doesn't apply. */
async function oldSkill(slug: string, source: 'human' | 'agent', body = 'Original body.') {
  const s = await saveSkillSource(slug, skillMd(slug, body, source), null, source)
  await db().update(agentConfigRevisions).set({ createdAt: new Date(Date.now() - 2 * 24 * 3600_000) })
    .where(and(eq(agentConfigRevisions.targetKind, 'skill'), eq(agentConfigRevisions.targetId, s.id)))
  return s
}

beforeAll(async () => {
  ;[modeSnapshot] = await db().select().from(settings).where(eq(settings.key, SELF_IMPROVEMENT_MODE_KEY))
  ;[profileSnapshot] = await db().select().from(agentProfile)
  profileRevisionIds = (await db().select({ id: agentConfigRevisions.id }).from(agentConfigRevisions)
    .where(eq(agentConfigRevisions.targetKind, 'profile'))).map(r => r.id)
  await setSelfImprovementMode('on')
})

afterAll(async () => {
  if (improvementIds.length) {
    // Filler rows' revisions (cap test) point at no real target: remove them by improvement id.
    await db().delete(agentConfigRevisions).where(inArray(agentConfigRevisions.improvementId, improvementIds))
    await db().delete(reviewQueue).where(and(eq(reviewQueue.targetKind, 'improvement'), inArray(reviewQueue.targetId, improvementIds)))
    await db().delete(agentImprovements).where(inArray(agentImprovements.id, improvementIds))
  }
  const skillIds = (await db().select({ id: agentSkills.id }).from(agentSkills).where(like(agentSkills.slug, `${TAG}%`))).map(r => r.id)
  if (skillIds.length) {
    await db().delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'skill'), inArray(agentConfigRevisions.targetId, skillIds)))
    await db().delete(agentSkills).where(inArray(agentSkills.id, skillIds))
  }
  const jobIds = [...deletedJobIds, ...(await db().select({ id: agentJobs.id }).from(agentJobs).where(like(agentJobs.slug, `${TAG}%`))).map(r => r.id)]
  if (jobIds.length) {
    await db().delete(agentConfigRevisions).where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, jobIds)))
    await db().delete(agentJobs).where(inArray(agentJobs.id, jobIds))
    expect(await db().select({ id: agentConfigRevisions.id }).from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.targetKind, 'job'), inArray(agentConfigRevisions.targetId, jobIds)))).toHaveLength(0)
  }
  // Profile: drop the revisions this file added; put the row back as it was (or remove the one we created).
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
  if (modeSnapshot) await db().update(settings).set({ value: modeSnapshot.value, updatedAt: modeSnapshot.updatedAt }).where(eq(settings.key, SELF_IMPROVEMENT_MODE_KEY))
  else await db().delete(settings).where(eq(settings.key, SELF_IMPROVEMENT_MODE_KEY))

  expect(await db().select({ id: agentSkills.id }).from(agentSkills).where(like(agentSkills.slug, `${TAG}%`))).toHaveLength(0)
  expect(await db().select({ id: agentJobs.id }).from(agentJobs).where(like(agentJobs.slug, `${TAG}%`))).toHaveLength(0)
  expect(await db().select({ id: agentImprovements.id }).from(agentImprovements).where(like(agentImprovements.target, `${TAG}%`))).toHaveLength(0)
})

describe('processProposal → applyImprovement', () => {
  it('skill.create auto-applies as Bridget, with an agent revision carrying the improvement id', async () => {
    const slug = `${TAG}create`
    // The reflector wrote `source: human`; a new skill is Bridget's whatever the file says.
    const r = await run(proposal('skill.create', slug, skillMd(slug, 'Summarise in three bullets.', 'human')), src(null))
    expect(r.status).toBe('applied')

    const skill = await getSkillSource(slug)
    expect(skill?.source).toBe('agent')
    expect(skill?.content).toContain('Summarise in three bullets.')
    const revs = await revisionsFor(r.improvementId)
    expect(revs).toHaveLength(1)
    expect(revs[0]).toMatchObject({ targetKind: 'skill', targetId: skill!.id, actor: 'agent' })

    const row = await improvement(r.improvementId)
    expect(row).toMatchObject({ route: 'auto', status: 'applied', revisionId: revs[0]!.id, pass: 'thread' })
    expect(row.decidedAt).not.toBeNull()
    expect(await reviewItem(r.improvementId)).toBeUndefined()
  })

  it('a skill.create over an existing Tony skill is tiered as an edit of it → review', async () => {
    const slug = `${TAG}exists`
    const s = await oldSkill(slug, 'human')
    const r = await run(proposal('skill.create', slug, skillMd(slug, 'Replacement.')), src(s.contentHash))
    expect(r.status).toBe('pending_review')
    expect((await improvement(r.improvementId)).proposal).toMatchObject({ reasons: ['tier'], currentContent: s.content })
    expect((await getSkillSource(slug))!.content).toBe(s.content)
  })

  it('a skill.edit of Tony\'s skill goes to review; approving applies it as actor human', async () => {
    const slug = `${TAG}human`
    const s = await oldSkill(slug, 'human')
    const newContent = skillMd(slug, 'Use three bullet points.', 'agent')
    const r = await run(proposal('skill.edit', slug, newContent), src(s.contentHash))
    expect(r.status).toBe('pending_review')
    expect((await getSkillSource(slug))!.content).toBe(s.content)

    const item = await reviewItem(r.improvementId)
    expect(item).toMatchObject({ kind: 'self-improvement', status: 'pending' })
    const proposed = item!.proposed as { improvementId: string; proposal: Proposal; reasons: string[]; jev: unknown; currentContent: string }
    expect(proposed.improvementId).toBe(r.improvementId)
    expect(proposed.proposal).toMatchObject({ kind: 'skill.edit', target: slug, evidence: EVIDENCE })
    expect(proposed.reasons).toEqual(['tier'])
    expect(proposed.jev).toMatchObject({ risky: false, model: 'stub' })
    expect(proposed.currentContent).toBe(s.content)
    expect((await improvement(r.improvementId)).reviewItemId).toBe(item!.id)

    await approveHandlers['self-improvement']!(item!)
    const after = await getSkillSource(slug)
    expect(after!.content).toContain('Use three bullet points.')
    // The edit kept Tony's authorship even though the proposal's file said `source: agent`.
    expect(after!.source).toBe('human')
    const revs = await revisionsFor(r.improvementId)
    expect(revs).toHaveLength(1)
    expect(revs[0]!.actor).toBe('human')
    expect(await improvement(r.improvementId)).toMatchObject({ status: 'applied', revisionId: revs[0]!.id })
    expect((await reviewItem(r.improvementId))!.status).toBe('approved')
  })

  it('CAS conflict on the auto path: Tony edits between the pass and the apply → conflict review item, nothing overwritten', async () => {
    const slug = `${TAG}race`
    const s = await oldSkill(slug, 'agent')
    const tonyContent = skillMd(slug, 'Tony rewrote this mid-pass.', 'agent')
    // Jev runs after the target is read and before the apply: Tony's edit lands exactly in that gap.
    const racingJev = async () => { await saveSkillSource(slug, tonyContent, s.contentHash, 'human'); return okJev() }
    const r = await run(proposal('skill.edit', slug, skillMd(slug, 'Agent edit.')), src(s.contentHash), racingJev)
    expect(r.status).toBe('conflict')

    const now = await getSkillSource(slug)
    expect(now!.content).toBe(tonyContent)
    expect(await revisionsFor(r.improvementId)).toHaveLength(0)
    const row = await improvement(r.improvementId)
    expect(row.route).toBe('auto')
    expect(row.status).toBe('conflict')
    expect(row.proposal as StoredProposal).toMatchObject({ currentContent: tonyContent, expectedHash: now!.contentHash })
    const item = await reviewItem(r.improvementId)
    expect(item?.status).toBe('pending')
    expect((item!.proposed as { currentContent: string }).currentContent).toBe(tonyContent)

    // Tony approves it: that is HIS change, so it never counts against today's auto cap.
    const autoBefore = await countAutoAppliedToday()
    await approveHandlers['self-improvement']!(item!)
    expect((await getSkillSource(slug))!.content).toContain('Agent edit.')
    expect(await improvement(r.improvementId)).toMatchObject({ route: 'auto', status: 'applied' })
    expect((await revisionsFor(r.improvementId))[0]!.actor).toBe('human')
    expect(await countAutoAppliedToday()).toBe(autoBefore)
  })

  it('a conflict refresh re-derives `source:` from the current file: approving can\'t relabel Tony\'s skill', async () => {
    const slug = `${TAG}relabel`
    const tonyContent = skillMd(slug, 'Tony created this slug mid-pass.', 'human')
    // The slug is missing at pass time (so the proposal is written `source: agent`); Tony creates it before the apply.
    const racingJev = async () => { await saveSkillSource(slug, tonyContent, null, 'human'); return okJev() }
    const r = await run(proposal('skill.create', slug, skillMd(slug, 'Agent version.')), src(null), racingJev)
    expect(r.status).toBe('conflict')
    const stored = (await improvement(r.improvementId)).proposal as StoredProposal
    expect(parseSkillMarkdown(stored.content!).input.source).toBe('human')
    const item = await reviewItem(r.improvementId)
    expect(parseSkillMarkdown((item!.proposed as { proposal: { content: string } }).proposal.content).input.source).toBe('human')

    await approveHandlers['self-improvement']!(item!)
    const after = await getSkillSource(slug)
    expect(after!.content).toContain('Agent version.')
    expect(after!.source).toBe('human')
  })

  it('CAS conflict on approve: 409, the item stays pending with fresh content; a second approve applies', async () => {
    const slug = `${TAG}stale`
    const s = await oldSkill(slug, 'human')
    const r = await run(proposal('skill.edit', slug, skillMd(slug, 'Proposed body.')), src(s.contentHash))
    expect(r.status).toBe('pending_review')
    const tonyContent = skillMd(slug, 'Tony edited after the proposal.', 'human')
    await saveSkillSource(slug, tonyContent, s.contentHash, 'human')

    const err = await approveHandlers['self-improvement']!((await reviewItem(r.improvementId))!).catch(e => e)
    expect(err?.statusCode).toBe(409)
    expect(err?.data).toMatchObject({ summary: SELF_IMPROVEMENT_CONFLICT, current: { content: tonyContent } })
    expect((await getSkillSource(slug))!.content).toBe(tonyContent)
    const item = await reviewItem(r.improvementId)
    expect(item!.status).toBe('pending')
    expect((item!.proposed as { currentContent: string }).currentContent).toBe(tonyContent)
    expect((await improvement(r.improvementId)).status).toBe('conflict')

    // Tony reloads the review, sees the diff against his edit, and approves again.
    await approveHandlers['self-improvement']!(item!)
    expect((await getSkillSource(slug))!.content).toContain('Proposed body.')
    expect((await improvement(r.improvementId)).status).toBe('applied')
  })

  it('profile.edit goes to review; approving updates the profile with provenance', async () => {
    const before = await getProfileSource()
    const content = `${before.content}\n- Prefers weekly reports as three bullet points.`.trim()
    const r = await run(proposal('profile.edit', 'profile', content), src(before.contentHash))
    expect(r.status).toBe('pending_review')
    expect((await getProfileSource()).content).toBe(before.content)

    await approveHandlers['self-improvement']!((await reviewItem(r.improvementId))!)
    expect((await getProfileSource()).content).toBe(content)
    const revs = await revisionsFor(r.improvementId)
    expect(revs).toHaveLength(1)
    expect(revs[0]).toMatchObject({ targetKind: 'profile', actor: 'human' })
  })

  it('reject records `rejected` with the delta; the same proposal next time is dropped (rejected_recently)', async () => {
    const slug = `${TAG}reject`
    const s = await oldSkill(slug, 'human')
    const p = proposal('skill.edit', slug, skillMd(slug, 'Original body.\nAlways add a TL;DR line at the top of every weekly report.'))
    const r = await run(p, src(s.contentHash))
    await rejectHandlers['self-improvement']!((await reviewItem(r.improvementId))!)

    const row = await improvement(r.improvementId)
    expect(row.status).toBe('rejected')
    expect(row.decidedAt).not.toBeNull()
    expect((row.proposal as StoredProposal).delta).toBe('always add a tl dr line at the top of every weekly report')
    expect((await reviewItem(r.improvementId))!.status).toBe('rejected')

    const again = await run(p, src(s.contentHash))
    expect(again.status).toBe('dropped')
    expect(await improvement(again.improvementId)).toMatchObject({ route: 'dropped', dropReason: 'rejected_recently', status: 'dropped' })
    expect(await reviewItem(again.improvementId)).toBeUndefined()
    expect((await getSkillSource(slug))!.content).toBe(s.content)
  })

  it('job.disable goes to review; a rejected one is not asked again for 30 days', async () => {
    const slug = `${TAG}job`
    const job = await createJob({ slug, content: jobMd('Scratch job.'), actor: 'agent' })
    const jobSrc = src(job.contentHash, { pass: 'jobs', input: 'always summarise the weekly report in three bullet points', userInput: ['always summarise the weekly report in three bullet points'] })
    const r = await run(proposal('job.disable', slug), jobSrc)
    expect(r.status).toBe('pending_review')
    expect((await improvement(r.improvementId)).proposal).toMatchObject({ reasons: ['tier'] })
    expect((await getJob(slug))!.enabled).toBe(true)

    await rejectHandlers['self-improvement']!((await reviewItem(r.improvementId))!)
    const again = await run(proposal('job.disable', slug, undefined, 'Worded differently this time'), jobSrc)
    expect(again.status).toBe('dropped')
    expect((await improvement(again.improvementId)).dropReason).toBe('rejected_recently')
  })

  it('an approved job.disable disables the job with provenance', async () => {
    const slug = `${TAG}job2`
    const job = await createJob({ slug, content: jobMd('Scratch job 2.'), actor: 'human' })
    const r = await run(proposal('job.disable', slug), src(job.contentHash, { pass: 'jobs' }))
    await approveHandlers['self-improvement']!((await reviewItem(r.improvementId))!)
    expect((await getJob(slug))!.enabled).toBe(false)
    expect(await revisionsFor(r.improvementId)).toHaveLength(1)
  })

  it('rejection memory treats skill.create and skill.edit of one slug as one family', async () => {
    const slug = `${TAG}family`
    const s = await oldSkill(slug, 'human')
    const content = skillMd(slug, 'Original body.\nAlways lead the weekly report with the three biggest risks.')
    const r = await run(proposal('skill.edit', slug, content), src(s.contentHash))
    await rejectHandlers['self-improvement']!((await reviewItem(r.improvementId))!)
    const again = await run(proposal('skill.create', slug, content), src(s.contentHash))
    expect(await improvement(again.improvementId)).toMatchObject({ status: 'dropped', dropReason: 'rejected_recently' })
  })

  it('an edit of a skill whose full file the reflector never saw is dropped (body_not_shown)', async () => {
    const slug = `${TAG}unseen`
    const s = await oldSkill(slug, 'agent')
    const r = await run(proposal('skill.edit', slug, skillMd(slug, 'Blind rewrite.')), src(s.contentHash, { shownSkills: [] }))
    expect(await improvement(r.improvementId)).toMatchObject({ status: 'dropped', dropReason: 'invalid: body_not_shown' })
    // Shown in full → not dropped on that ground.
    const ok = await run(proposal('skill.edit', slug, skillMd(slug, 'Seen rewrite.')), src(s.contentHash, { shownSkills: [slug] }))
    expect(ok.status).toBe('applied')
  })

  it('the mode is re-read after Jev: switched to review_only mid-call → review, not auto', async () => {
    const slug = `${TAG}modeflip`
    const flippingJev = async () => { await setSelfImprovementMode('review_only'); return okJev() }
    try {
      const r = await run(proposal('skill.create', slug, skillMd(slug, 'Mode flip.')), src(null), flippingJev)
      expect(r.status).toBe('pending_review')
      expect((await improvement(r.improvementId)).proposal).toMatchObject({ reasons: ['review_only'] })
      expect(await getSkillSource(slug)).toBeNull()
    } finally {
      await setSelfImprovementMode('on')
    }
  })

  describe('job.edit', () => {
    const jobSrc = (hash: string, content: string) =>
      src(hash, { pass: 'jobs', input: EVIDENCE[0]!, userInput: [EVIDENCE[0]!], baseContent: content })

    it('of Bridget\'s job auto-applies through saveJob with provenance', async () => {
      const slug = `${TAG}jedit`
      const j = await oldJob(slug, 'agent')
      const content = md('trigger: at 2100-01-01T09:00:00Z\nenabled: true', 'Three bullet points, please.')
      const r = await run(proposal('job.edit', slug, content), jobSrc(j.contentHash, j.content))
      expect(r.status).toBe('applied')
      expect((await getJob(slug))!.content).toBe(content)
      const revs = await revisionsFor(r.improvementId)
      expect(revs).toHaveLength(1)
      expect(revs[0]).toMatchObject({ targetKind: 'job', targetId: j.id, actor: 'agent' })
    })

    it('of Tony\'s job goes to review', async () => {
      const slug = `${TAG}jhuman`
      const j = await oldJob(slug, 'human')
      const r = await run(proposal('job.edit', slug, md('trigger: at 2100-01-01T09:00:00Z\nenabled: true', 'Edited.')), jobSrc(j.contentHash, j.content))
      expect(r.status).toBe('pending_review')
      expect((await improvement(r.improvementId)).proposal).toMatchObject({ reasons: ['tier'] })
    })

    it('that turns Bridget\'s job OFF goes to review (changes_enabled); the job stays on', async () => {
      const slug = `${TAG}joff`
      const j = await oldJob(slug, 'agent', true)
      const r = await run(proposal('job.edit', slug, md('trigger: at 2100-01-01T09:00:00Z\nenabled: false', 'Scratch job body.')), jobSrc(j.contentHash, j.content))
      expect(r.status).toBe('pending_review')
      expect((await improvement(r.improvementId)).proposal).toMatchObject({ reasons: ['changes_enabled'] })
      expect((await getJob(slug))!.enabled).toBe(true)
    })

    it('that turns Bridget\'s job ON goes to review (changes_enabled); the job stays off', async () => {
      const slug = `${TAG}jon`
      const j = await oldJob(slug, 'agent', false)
      const r = await run(proposal('job.edit', slug, md('trigger: at 2100-01-01T09:00:00Z\nenabled: true', 'Scratch job body.')), jobSrc(j.contentHash, j.content))
      expect(r.status).toBe('pending_review')
      expect((await improvement(r.improvementId)).proposal).toMatchObject({ reasons: ['changes_enabled'] })
      expect((await getJob(slug))!.enabled).toBe(false)
    })

    it('approve after the job was deleted: a clean 422 with a summary, the item stays pending', async () => {
      const slug = `${TAG}jgone`
      const j = await oldJob(slug, 'human')
      const r = await run(proposal('job.edit', slug, md('trigger: at 2100-01-01T09:00:00Z\nenabled: true', 'Edited.')), jobSrc(j.contentHash, j.content))
      deletedJobIds.push(j.id)
      await deleteJob(slug)
      const err = await approveHandlers['self-improvement']!((await reviewItem(r.improvementId))!).catch(e => e)
      expect(err?.statusCode).toBe(422)
      expect(err?.data?.summary).toMatch(/^Could not apply: /)
      expect((await reviewItem(r.improvementId))!.status).toBe('pending')
    })
  })

  it('the 6th auto-apply within a day goes to review (cap)', async () => {
    // Fill today's count up to 5 with scoped rows (the count is global: read the baseline first).
    const fill = Math.max(0, 5 - await countAutoAppliedToday())
    if (fill) {
      const rows = await db().insert(agentImprovements).values(Array.from({ length: fill }, (_, i) => ({
        pass: 'thread', kind: 'skill.create', target: `${TAG}filler-${i}`, proposal: {}, route: 'auto', status: 'applied', decidedAt: new Date()
      }))).returning({ id: agentImprovements.id })
      improvementIds.push(...rows.map(r => r.id))
      // Applied BY THE AGENT: each carries an agent revision (they point at no real target).
      await db().insert(agentConfigRevisions).values(rows.map(r => ({
        targetKind: 'skill', targetId: randomUUID(), content: '', actor: 'agent', improvementId: r.id
      })))
    }
    expect(await countAutoAppliedToday()).toBeGreaterThanOrEqual(5)

    const slug = `${TAG}sixth`
    const r = await run(proposal('skill.create', slug, skillMd(slug, 'Sixth.')), src(null))
    expect(r.status).toBe('pending_review')
    expect((await improvement(r.improvementId)).proposal).toMatchObject({ reasons: ['cap'] })
    expect(await getSkillSource(slug)).toBeNull()
  })
})
