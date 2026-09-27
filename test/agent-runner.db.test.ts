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
import { createRun, claimNextRun, finishRun } from '../server/lib/agent/runtime/runs'
import { resolveSession } from '../server/lib/agent/runtime/sessions'
import { runTurn } from '../server/lib/agent/runtime/runner'
import { StreamHub } from '../server/lib/agent/runtime/stream'
import { abortRun } from '../server/lib/agent/runtime/aborts'
import { eq, inArray } from 'drizzle-orm'

const convIds: string[] = []
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

  it('user/assistant message ids name the right rows on every turn (same-transaction created_at tie)', async () => {
    // One appendMessages call writes both rows under one transaction's now(), so ordering by
    // (created_at, id) picks between them by random uuid — right half the time. Ten turns make a
    // lucky pass of that ordering a ~1/1000 event.
    const { run: first, conversationId } = await queued('turn 0')
    let run = first
    for (let i = 0; i < 10; i++) {
      const out = await runTurn(run, { runAgent: fakeAgent(`reply ${i}`) as never, assemble: noAssemble as never, hub: new StreamHub() })
      const r = await rows(conversationId)
      expect(r.find(x => x.id === out.userMessageId)?.content).toBe(`turn ${i}`)
      expect(r.find(x => x.id === out.assistantMessageId)?.content.trim()).toBe(`reply ${i}`)
      await finishRun(run.id, out)
      if (i < 9) {
        await createRun({ conversationId, sessionKey: `thread:${conversationId}`, trigger: 'user', profile: 'interactive', input: { text: `turn ${i + 1}`, modality: 'text' } })
        run = (await claimNextRun({ onlyConversations: [conversationId] }))!
      }
    }
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
  })

  it('a wake run persists an event row (not a user row) and drops a NO_REPLY reply', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'RUNNER-TEST wake' })
    convIds.push(s.conversationId)
    await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'admin', input: { text: 'anything new?', modality: 'text' } })
    const run = (await claimNextRun({ onlyConversations: [s.conversationId] }))!
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
})
