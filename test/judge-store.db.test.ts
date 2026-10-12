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
import { recordVerdict, recordDecision, getVerdictRecord } from '@mymind/core/lib/agent/judge/store'
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
    expect(await getJudgeSettings()).toEqual({ enabled: true, smartApprovals: { workstreams: true, chat: false }, confidence: 0.9 })
  })

  it('save merges a patch, persists it, and caches until invalidated', async () => {
    const saved = await saveAgentSettings({ judge: { smartApprovals: { chat: true }, confidence: 0.8 } })
    expect(saved.judge).toEqual({ enabled: true, smartApprovals: { workstreams: true, chat: true }, confidence: 0.8 })
    const [row] = await useDb().select().from(settings).where(eq(settings.key, AGENT_SETTINGS_KEY))
    expect(row!.value).toEqual(saved)
    // Another process writes behind this one's back: the cache holds until invalidated.
    await useDb().update(settings).set({ value: { judge: { enabled: false } } }).where(eq(settings.key, AGENT_SETTINGS_KEY))
    expect((await getJudgeSettings()).enabled).toBe(true)
    invalidateAgentSettings()
    expect(await getJudgeSettings()).toEqual({ enabled: false, smartApprovals: { workstreams: true, chat: false }, confidence: 0.9 })
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
    expect(await get(session)).toEqual(out)

    invalidate.mockClear()
    await expect(put({ ...session, body: { judge: { confidence: 2 } } })).rejects.toMatchObject({ statusCode: 400, data: expect.stringContaining('judge.confidence') })
    expect(invalidate).not.toHaveBeenCalled()
    await expect(put({ context: { client: { type: 'api-token' } }, body: {} })).rejects.toMatchObject({ statusCode: 403 })
    await expect(get({ context: {} })).rejects.toMatchObject({ statusCode: 403 })
  })
})
