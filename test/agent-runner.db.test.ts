// test/agent-runner.db.test.ts
//
// DB-backed test — harness copied from test/agent-runs.db.test.ts (`.env` load +
// `useRuntimeConfig` stub BEFORE importing server/db). The dev DB is shared: only rows in
// conversations this file created are deleted.
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { useDb } from '../server/db'
import { conversations, conversationMessages, agentRuns } from '../server/db/schema'
import { createRun, claimNextRun } from '../server/lib/agent/runtime/runs'
import { resolveSession } from '../server/lib/agent/runtime/sessions'
import { runTurn } from '../server/lib/agent/runtime/runner'
import { StreamHub } from '../server/lib/agent/runtime/stream'
import { abortRun } from '../server/lib/agent/runtime/aborts'
import { appendMessages } from '../server/services/conversations'
import { eq, inArray } from 'drizzle-orm'

const convIds: string[] = []
// Runs here are never finished (runTurn leaves that to its caller), so a headless run stays
// 'running' and would block the next wake claim at the real 1-slot limit.
const HEADLESS_TEST_SLOTS = 1000
afterAll(async () => {
  const db = useDb()
  await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
})

const noAssemble = async () => ({ context: '', usedMemoryIds: [], used: 0, droppedTurns: 0 })
function fakeAgent(reply: string, opts: { delayMs?: number } = {}) {
  return async function* (_m: unknown, ctx: { signal: AbortSignal }) {
    for (const ch of reply.split(' ')) {
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
      if (ctx.signal.aborted) return
      yield { type: 'text-delta', text: ch + ' ' } as const
    }
    yield { type: 'done' } as const
  }
}
async function queued(text: string, extra: Partial<Parameters<typeof createRun>[0]> = {}) {
  const s = await resolveSession('thread:new', { titleHint: `RUNNER-TEST ${text}` })
  convIds.push(s.conversationId)
  await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'user', profile: 'interactive', input: { text, modality: 'text' }, ...extra })
  const run = await claimNextRun({ onlyConversations: [s.conversationId] })
  return { run: run!, conversationId: s.conversationId }
}
const rows = (id: string) => useDb().select().from(conversationMessages).where(eq(conversationMessages.conversationId, id)).orderBy(conversationMessages.createdAt, conversationMessages.id)

describe('runTurn', () => {
  it('runs with no subscriber at all and persists user + assistant', async () => {
    const { run, conversationId } = await queued('hello')
    const out = await runTurn(run, { runAgent: fakeAgent('hi there') as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(out.status).toBe('done')
    const r = await rows(conversationId)
    // Sorted by role, not (created_at, id): both rows share one transaction's now(), so the
    // id tie-break orders them arbitrarily.
    expect(r.map(x => [x.role, x.content.trim()]).sort()).toEqual([['assistant', 'hi there'], ['user', 'hello']])
    expect(out.userMessageId).toBeTruthy()
    expect(out.assistantMessageId).toBeTruthy()
    // The ids must name the RIGHT rows, not merely two rows.
    expect(r.find(x => x.id === out.userMessageId)?.role).toBe('user')
    expect(r.find(x => x.id === out.assistantMessageId)?.role).toBe('assistant')
  })

  it('appendMessages returns the inserted ids in insertion order', async () => {
    // The rows of one call share a created_at, so this return value is the only reliable order.
    const s = await resolveSession('thread:new', { titleHint: 'RUNNER-TEST append-ids' })
    convIds.push(s.conversationId)
    const ids = await appendMessages(s.conversationId, ['a', 'b', 'c'].map(c => ({ role: 'user' as const, content: c, modality: 'text' as const })))
    const r = await rows(s.conversationId)
    expect(ids.map(id => r.find(x => x.id === id)?.content)).toEqual(['a', 'b', 'c'])
  })

  it('streams frames to a subscriber and ends with a persisted frame', async () => {
    const { run, conversationId } = await queued('stream me')
    const hub = new StreamHub()
    const got: string[] = []
    hub.subscribe(conversationId, { id: 's', send: (d) => {
      if (typeof d === 'string') got.push(d)
    } })
    await runTurn(run, { runAgent: fakeAgent('ok') as never, assemble: noAssemble as never, hub })
    const types = got.map(f => JSON.parse(f).type)
    expect(types).toContain('user-message')
    expect(types).toContain('chunk')
    expect(types[types.length - 1]).toBe('persisted')
  })

  it('an abort mid-reply rescues what was said and reports aborted', async () => {
    const { run, conversationId } = await queued('long one')
    const p = runTurn(run, { runAgent: fakeAgent('one two three four five six', { delayMs: 30 }) as never, assemble: noAssemble as never, hub: new StreamHub() })
    await new Promise(r => setTimeout(r, 70))
    abortRun(run.id)
    const out = await p
    expect(out.status).toBe('aborted')
    const r = await rows(conversationId)
    expect(r.find(x => x.role === 'user')?.content).toBe('long one') // the question survives
    // …and so does what Bridget had said before the Stop.
    expect(r.find(x => x.role === 'assistant')?.content.trim()).toMatch(/^one\b/)
  })

  it('an abort that surfaces as a non-AbortError is still reported aborted', async () => {
    const { run } = await queued('torn down')
    const tearsDown = async function* (_m: unknown, ctx: { signal: AbortSignal }) {
      yield { type: 'text-delta', text: 'start ' } as const
      await new Promise(r => setTimeout(r, 60))
      if (ctx.signal.aborted) throw new Error('socket hang up')
      yield { type: 'text-delta', text: 'never' } as const
    }
    const p = runTurn(run, { runAgent: tearsDown as never, assemble: noAssemble as never, hub: new StreamHub() })
    await new Promise(r => setTimeout(r, 20))
    abortRun(run.id)
    expect((await p).status).toBe('aborted')
  })

  it('a wake run persists an event row (not a user row) and drops a NO_REPLY reply', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'RUNNER-TEST wake' })
    convIds.push(s.conversationId)
    await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'admin', input: { text: 'anything new?', modality: 'text' } })
    const run = (await claimNextRun({ onlyConversations: [s.conversationId], headlessSlots: HEADLESS_TEST_SLOTS }))!
    const out = await runTurn(run, { runAgent: fakeAgent('NO_REPLY') as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(out.suppressed).toBe(true)
    const r = await rows(s.conversationId)
    expect(r.map(x => [x.role, x.origin])).toEqual([['event', 'wake:admin']])
  })

  it('a thrown agent error marks the run failed and still keeps the question', async () => {
    const { run, conversationId } = await queued('explode')
    const boom = async function* () {
      yield { type: 'text-delta', text: 'partial ' } as const
      throw new Error('model died')
    }
    const out = await runTurn(run, { runAgent: boom as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/model died/)
    expect((await rows(conversationId)).find(x => x.role === 'user')?.content).toBe('explode')
  })

  it('a failure before the model ever runs (assembly throws) still keeps the question', async () => {
    const { run, conversationId } = await queued('before-model')
    const boom = async () => {
      throw new Error('assembler exploded')
    }
    const out = await runTurn(run, { runAgent: fakeAgent('never') as never, assemble: boom as never, hub: new StreamHub() })
    expect(out.status).toBe('failed')
    expect((await rows(conversationId)).map(r => [r.role, r.content])).toEqual([['user', 'before-model']])
  })

  async function wakeRun(reason: string) {
    const s = await resolveSession('thread:new', { titleHint: `RUNNER-TEST wake ${reason}` })
    convIds.push(s.conversationId)
    await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: reason, input: { text: 'anything new?', modality: 'text' } })
    return { run: (await claimNextRun({ onlyConversations: [s.conversationId], headlessSlots: HEADLESS_TEST_SLOTS }))!, conversationId: s.conversationId }
  }
  function throwsAfter(text: string) {
    return async function* () {
      yield { type: 'text-delta', text } as const
      throw new Error('model died')
    }
  }

  it('a wake that throws rescues an EVENT row (raw prompt) plus the partial reply', async () => {
    const { run, conversationId } = await wakeRun('rescue')
    const out = await runTurn(run, { runAgent: throwsAfter('half an answer ') as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(out.status).toBe('failed')
    const r = await rows(conversationId)
    expect(r.map(x => [x.role, x.origin, x.content.trim()]).sort()).toEqual([
      ['assistant', null, 'half an answer'],
      ['event', 'wake:rescue', 'anything new?']
    ])
  })

  it('a wake that throws after NO_REPLY rescues only the event row', async () => {
    const { run, conversationId } = await wakeRun('rescue-silent')
    await runTurn(run, { runAgent: throwsAfter('NO_REPLY ') as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect((await rows(conversationId)).map(x => [x.role, x.origin])).toEqual([['event', 'wake:rescue-silent']])
  })

  it('afterPersist fires when the turn persisted or was rescued, and not otherwise', async () => {
    const seen: string[] = []
    const afterPersist = (id: string) => seen.push(id)
    const ok = await queued('persist me')
    await runTurn(ok.run, { runAgent: fakeAgent('fine') as never, assemble: noAssemble as never, hub: new StreamHub(), afterPersist })
    expect(seen).toEqual([ok.conversationId])

    const bad = await queued('rescue me')
    await runTurn(bad.run, { runAgent: throwsAfter('partial ') as never, assemble: noAssemble as never, hub: new StreamHub(), afterPersist })
    expect(seen).toEqual([ok.conversationId, bad.conversationId])

    // Nothing to persist and nothing to rescue: an empty question produces no rows at all.
    const empty = await queued('')
    await runTurn(empty.run, { runAgent: fakeAgent('never') as never, assemble: noAssemble as never, hub: new StreamHub(), afterPersist })
    expect(await rows(empty.conversationId)).toEqual([])
    expect(seen).toEqual([ok.conversationId, bad.conversationId])
  })
})
