// DB-backed — cycle 84 Task 1: the approval_verdicts store round trip (rule row → verdict → first
// decision wins; a late verdict changes no decision) and the agent settings doc (defaults, save,
// cache + invalidate, the Settings routes). The dev DB is SHARED: verdict rows use nonces this
// file mints and are deleted in afterAll; the `agent_settings` row is snapshotted and restored.
process.loadEnvFile('.env')

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))
const invalidate = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@mymind/core/lib/bus/invalidate', () => ({ invalidateWorkerCache: invalidate }))
vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
vi.stubGlobal('createError', (o: { statusCode: number, statusMessage?: string, data?: unknown }) => Object.assign(new Error(o.statusMessage ?? 'err'), o))
vi.stubGlobal('readBody', async (e: { body: unknown }) => e.body)

import { randomUUID } from 'node:crypto'
import { eq, like } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { approvalVerdicts, settings, type SettingRow } from '@mymind/core/db/schema'
import { recordVerdict, recordDecision, getVerdictRecord, closeLostVerdicts, pruneVerdicts } from '@mymind/core/lib/agent/judge/store'
import {
  AGENT_SETTINGS_KEY, getAgentSettings, getJudgeSettings, saveAgentSettings, invalidateAgentSettings, defaultAgentSettings
} from '@mymind/core/lib/agent/agent-settings'
import type { JudgeVerdict } from '@mymind/core/lib/agent/judge/types'

const PREFIX = `judge-test-${randomUUID()}-`
const nonce = () => `${PREFIX}${randomUUID()}`
let snapshot: SettingRow[] = []

type H = (e: unknown) => Promise<unknown>
const session = { context: { client: { type: 'session' } } }

beforeAll(async () => {
  snapshot = await useDb().select().from(settings).where(eq(settings.key, AGENT_SETTINGS_KEY))
})

afterAll(async () => {
  const db = useDb()
  await db.delete(approvalVerdicts).where(like(approvalVerdicts.nonce, `${PREFIX}%`))
  await db.delete(settings).where(eq(settings.key, AGENT_SETTINGS_KEY))
  if (snapshot.length) await db.insert(settings).values(snapshot)
  invalidateAgentSettings()
})

const verdict: JudgeVerdict = { risk: 'low', recommendation: 'approve', confidence: 0.94, reasons: ['asked for <b>it</b>'], model: 'J1', latencyMs: 812 }

describe('final fix wave M2: lost rows and retention (scoped to this file\'s nonces)', () => {
  it('at boot, an undecided row from before the boot is closed lost/system; a decided row and a row of this boot are untouched', async () => {
    const [old, decided, mine] = [nonce(), nonce(), nonce()]
    for (const n of [old, decided]) await recordVerdict({ nonce: n, tool: 'gmail_send', rule: { floor: 'review', reasons: [] } })
    await recordDecision(decided, 'denied', 'tony')
    await new Promise(r => setTimeout(r, 20))
    const bootedAt = new Date()
    await new Promise(r => setTimeout(r, 20))
    await recordVerdict({ nonce: mine, tool: 'gmail_send', rule: { floor: 'review', reasons: [] } })
    expect(await closeLostVerdicts(bootedAt, { nonces: [old, decided, mine] })).toBe(1)
    expect(await getVerdictRecord(old)).toMatchObject({ decision: 'lost', decidedBy: 'system' })
    expect((await getVerdictRecord(old))!.decidedAt).toBeInstanceOf(Date)
    expect(await getVerdictRecord(decided)).toMatchObject({ decision: 'denied', decidedBy: 'tony' })
    expect(await getVerdictRecord(mine)).toMatchObject({ decision: null })
    // A late decision for the lost row changes nothing (first decision wins).
    expect(await recordDecision(old, 'approved', 'tony')).toBe(false)
  })

  it('rows older than 180 days are pruned; younger ones stay', async () => {
    const [aged, young] = [nonce(), nonce()]
    for (const n of [aged, young]) await recordVerdict({ nonce: n, tool: 'exec', rule: { floor: 'high', reasons: [] } })
    await useDb().update(approvalVerdicts).set({ createdAt: new Date(Date.now() - 181 * 24 * 60 * 60 * 1000) }).where(eq(approvalVerdicts.nonce, aged))
    await useDb().update(approvalVerdicts).set({ createdAt: new Date(Date.now() - 179 * 24 * 60 * 60 * 1000) }).where(eq(approvalVerdicts.nonce, young))
    expect(await pruneVerdicts(undefined, undefined, { nonces: [aged, young] })).toBe(1)
    expect(await getVerdictRecord(aged)).toBeNull()
    expect(await getVerdictRecord(young)).not.toBeNull()
  })
})

describe('approval_verdicts store (DB)', () => {
  it('rule row → verdict → decision round trip', async () => {
    const n = nonce()
    const runId = randomUUID()
    await recordVerdict({ nonce: n, runId, workstreamId: null, tool: 'exec', rule: { floor: 'high', reasons: ['reaches the network (curl)'] } })
    let row = await getVerdictRecord(n)
    expect(row).toMatchObject({ nonce: n, runId, workstreamId: null, tool: 'exec', ruleFloor: 'high', ruleReasons: ['reaches the network (curl)'], risk: null, recommendation: null, decision: null })

    await recordVerdict({ nonce: n, runId, tool: 'exec', rule: { floor: 'high', reasons: ['reaches the network (curl)'] }, verdict })
    row = await getVerdictRecord(n)
    expect(row).toMatchObject({ risk: 'low', recommendation: 'approve', reasons: ['asked for <b>it</b>'], model: 'J1', latencyMs: 812, error: null, decision: null })
    expect(row!.confidence).toBeCloseTo(0.94, 5)
    expect(row!.verdictAt).toBeInstanceOf(Date)

    expect(await recordDecision(n, 'auto', 'judge')).toBe(true)
    row = await getVerdictRecord(n)
    expect(row).toMatchObject({ decision: 'auto', decidedBy: 'judge' })
    expect(row!.decidedAt).toBeInstanceOf(Date)
  })

  it('first decision wins: a timeout after Tony decided is ignored', async () => {
    const n = nonce()
    await recordVerdict({ nonce: n, tool: 'gmail_send', rule: { floor: 'review', reasons: [] } })
    expect(await recordDecision(n, 'approved', 'tony')).toBe(true)
    expect(await recordDecision(n, 'timeout', 'timeout')).toBe(false)
    expect(await getVerdictRecord(n)).toMatchObject({ decision: 'approved', decidedBy: 'tony' })
  })

  it('a verdict landing after the decision is recorded and changes nothing about the decision', async () => {
    const n = nonce()
    await recordVerdict({ nonce: n, tool: 'exec', rule: { floor: 'review', reasons: [] } })
    await recordDecision(n, 'denied', 'tony')
    await recordVerdict({ nonce: n, tool: 'exec', rule: { floor: 'review', reasons: [] }, verdict })
    expect(await getVerdictRecord(n)).toMatchObject({ decision: 'denied', decidedBy: 'tony', recommendation: 'approve', model: 'J1' })
  })

  it('an error verdict is stored as such (risk null, review, confidence 0)', async () => {
    const n = nonce()
    await recordVerdict({ nonce: n, tool: 'exec', rule: { floor: 'review', reasons: [] }, verdict: { risk: null, recommendation: 'review', confidence: 0, reasons: [], model: null, latencyMs: 60000, error: 'judge timed out' } })
    expect(await getVerdictRecord(n)).toMatchObject({ risk: null, recommendation: 'review', confidence: 0, error: 'judge timed out', latencyMs: 60000, ruleFloor: 'review' })
  })

  it('the rule row is idempotent and never clobbers a verdict', async () => {
    const n = nonce()
    await recordVerdict({ nonce: n, tool: 'exec', rule: { floor: 'review', reasons: [] }, verdict })
    await recordVerdict({ nonce: n, tool: 'exec', rule: { floor: 'review', reasons: [] } })
    expect(await getVerdictRecord(n)).toMatchObject({ recommendation: 'approve' })
    expect(await useDb().select().from(approvalVerdicts).where(eq(approvalVerdicts.nonce, n))).toHaveLength(1)
  })

  it('no row for a nonce → recordDecision reports false', async () => {
    expect(await recordDecision(nonce(), 'approved', 'tony')).toBe(false)
    expect(await getVerdictRecord(nonce())).toBeNull()
  })
})

describe('agent settings doc (DB)', () => {
  it('no row → defaults', async () => {
    await useDb().delete(settings).where(eq(settings.key, AGENT_SETTINGS_KEY))
    invalidateAgentSettings()
    expect(await getAgentSettings()).toEqual(defaultAgentSettings())
    expect(await getJudgeSettings()).toEqual({ enabled: true, smartApprovals: { workstreams: false, chat: false }, confidence: 0.9, maxInFlight: 4 })
  })

  it('save merges a patch, persists it, and caches until invalidated', async () => {
    const saved = await saveAgentSettings({ judge: { smartApprovals: { chat: true }, confidence: 0.8 } })
    expect(saved.judge).toEqual({ enabled: true, smartApprovals: { workstreams: false, chat: true }, confidence: 0.8, maxInFlight: 4 })
    const [row] = await useDb().select().from(settings).where(eq(settings.key, AGENT_SETTINGS_KEY))
    expect(row!.value).toEqual(saved)
    // Another process writes behind this one's back: the cache holds until invalidated.
    await useDb().update(settings).set({ value: { judge: { enabled: false } } }).where(eq(settings.key, AGENT_SETTINGS_KEY))
    expect((await getJudgeSettings()).enabled).toBe(true)
    invalidateAgentSettings()
    expect(await getJudgeSettings()).toEqual({ enabled: false, smartApprovals: { workstreams: false, chat: false }, confidence: 0.9, maxInFlight: 4 })
  })

  it('I5: judge.maxInFlight sizes this process\'s judge/guard limiter — on save and on every (re)read', async () => {
    const { judgeSlotStats, setJudgeMaxInFlight } = await import('@mymind/core/lib/agent/judge/limiter')
    try {
      await saveAgentSettings({ judge: { maxInFlight: 7 } })
      expect(judgeSlotStats().max).toBe(7)
      setJudgeMaxInFlight(4)                                   // another process's value, say
      invalidateAgentSettings()
      await getAgentSettings()                                 // re-read from the row
      expect(judgeSlotStats().max).toBe(7)
    } finally {
      await saveAgentSettings({ judge: { maxInFlight: 4 } })
    }
    expect(judgeSlotStats().max).toBe(4)
  })

  it('an invalid patch throws and changes nothing', async () => {
    const before = await getAgentSettings()
    await expect(saveAgentSettings({ judge: { confidence: 0.3 } })).rejects.toThrow()
    invalidateAgentSettings()
    expect(await getAgentSettings()).toEqual(before)
  })

  it('PUT /api/settings/agent-settings saves, tells the worker, and 400s on bad input; GET reads back', async () => {
    const put = (await import('../server/api/settings/agent-settings.put')).default as H
    const get = (await import('../server/api/settings/agent-settings.get')).default as H
    invalidate.mockClear()
    const out = await put({ ...session, body: { judge: { enabled: true, smartApprovals: { workstreams: false } } } }) as { judge: { smartApprovals: { workstreams: boolean } } }
    expect(out.judge.smartApprovals.workstreams).toBe(false)
    expect(invalidate).toHaveBeenCalledWith('agent-settings')
    expect(await get(session)).toEqual({ ...out, problems: [] })

    invalidate.mockClear()
    await expect(put({ ...session, body: { judge: { confidence: 2 } } })).rejects.toMatchObject({ statusCode: 400, data: expect.stringContaining('judge.confidence') })
    expect(invalidate).not.toHaveBeenCalled()
    await expect(put({ context: { client: { type: 'api-token' } }, body: {} })).rejects.toMatchObject({ statusCode: 403 })
    await expect(get({ context: {} })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('fix round 1 (M1): GET names a corrupt stored field (read fail-closed); a PUT repairs the row', async () => {
    const get = (await import('../server/api/settings/agent-settings.get')).default as H
    const put = (await import('../server/api/settings/agent-settings.put')).default as H
    await useDb().insert(settings).values({ key: AGENT_SETTINGS_KEY, value: { judge: { enabled: 'yes', confidence: 7 } }, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: { judge: { enabled: 'yes', confidence: 7 } }, updatedAt: new Date() } })
    invalidateAgentSettings()
    expect(await get(session)).toMatchObject({ judge: { enabled: false, confidence: 0.99 }, problems: ['judge.enabled', 'judge.confidence'] })
    await put({ ...session, body: { judge: { enabled: true, smartApprovals: { workstreams: true, chat: false }, confidence: 0.9 } } })
    expect(await get(session)).toMatchObject({ judge: { enabled: true, confidence: 0.9 }, problems: [] })
  })
})
