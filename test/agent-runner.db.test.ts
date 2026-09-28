// test/agent-runner.db.test.ts
//
// DB-backed test — harness copied from test/agent-runs.db.test.ts (`.env` load +
// `useRuntimeConfig` stub BEFORE importing server/db). The dev DB is shared: only rows in
// conversations this file created are deleted.
process.loadEnvFile('.env')
import { describe, it, expect, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { useDb } from '../server/db'
import { conversations, conversationMessages, agentRuns, agentInbox } from '../server/db/schema'
import { createRun, claimNextRun } from '../server/lib/agent/runtime/runs'
import { resolveSession } from '../server/lib/agent/runtime/sessions'
import { runTurn } from '../server/lib/agent/runtime/runner'
import { StreamHub } from '../server/lib/agent/runtime/stream'
import { abortRun } from '../server/lib/agent/runtime/aborts'
import { registerApprovalChannel, hasApprovalChannel } from '../server/lib/agent/runtime/approvals'
import { appendMessages } from '../server/services/conversations'
import { pushSteer } from '../server/lib/agent/runtime/inbox'
import { jobOutcomeOf } from '../server/lib/agent/jobs/outcome'
import { eq, inArray } from 'drizzle-orm'

const convIds: string[] = []
// Runs here are never finished (runTurn leaves that to its caller), so a headless run stays
// 'running' and would block the next wake claim at the real 1-slot limit.
const HEADLESS_TEST_SLOTS = 1000
afterAll(async () => {
  const db = useDb()
  await db.delete(agentInbox).where(inArray(agentInbox.conversationId, convIds))
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
// Rows of one appendMessages call share created_at, so (created_at, id) cannot order them —
// the parent chain can. Walks from the root of a single-branch thread.
async function chain(id: string) {
  const all = await rows(id)
  const out: typeof all = []
  let next = all.find(x => x.parentId === null)
  while (next) {
    out.push(next)
    const at = next.id
    next = all.find(x => x.parentId === at)
  }
  expect(out.length).toBe(all.length) // single branch, nothing orphaned
  return out
}
// Drains once mid-stream (as runAgent's prepareStep would at a step boundary), after a steer was
// pushed for this very run, then replies — or throws, for the rescue path.
function steeredAgent(runId: string, conversationId: string, steer: string, opts: { reply?: string, throwAfter?: boolean } = {}) {
  return async function* (_m: unknown, ctx: { signal: AbortSignal, drainSteer?: () => Promise<string[]> }) {
    yield { type: 'text-delta', text: 'first ' } as const
    await pushSteer(runId, conversationId, steer, 'user')
    const got = await ctx.drainSteer!()
    expect(got).toEqual([steer]) // the runner hands runAgent the drained text unchanged
    if (opts.throwAfter) throw new Error('model died')
    if (opts.reply !== undefined) yield { type: 'text-delta', text: opts.reply } as const
    yield { type: 'done' } as const
  }
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

  it('drops the run\'s approval channel when the run ends (no leak until socket close)', async () => {
    const { run } = await queued('channel')
    registerApprovalChannel(run.id, async () => ({ approved: false }))
    expect(hasApprovalChannel(run.id)).toBe(true)
    await runTurn(run, { runAgent: fakeAgent('ok') as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(hasApprovalChannel(run.id)).toBe(false)
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

  // Cycle 74 D4 (replaces cycle 73's "the event row is kept"): a silent run leaves NOTHING in
  // the thread — only its agent_runs row (outcome suppressed). No rows, no persisted frame.
  it('a wake run that replies NO_REPLY persists zero rows and publishes no persisted frame', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'RUNNER-TEST wake' })
    convIds.push(s.conversationId)
    await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'admin', input: { text: 'anything new?', modality: 'text' } })
    const run = (await claimNextRun({ onlyConversations: [s.conversationId], headlessSlots: HEADLESS_TEST_SLOTS }))!
    const hub = new StreamHub()
    const got: string[] = []
    hub.subscribe(s.conversationId, { id: 'watcher', send: (d) => {
      if (typeof d === 'string') got.push(d)
    } })
    const afterPersist = vi.fn()
    const out = await runTurn(run, { runAgent: fakeAgent('NO_REPLY') as never, assemble: noAssemble as never, hub, afterPersist })
    expect(out).toMatchObject({ status: 'done', suppressed: true })
    // The run's outcome is the only trace — and a job reads it as 'silent' (Task 5's onRunFinished).
    expect(jobOutcomeOf(out).outcome).toBe('silent')
    expect(await rows(s.conversationId)).toEqual([])
    expect(got.map(f => JSON.parse(f).type)).not.toContain('persisted')
    expect(got.map(f => JSON.parse(f).type)).not.toContain('conversation')
    expect(afterPersist).not.toHaveBeenCalled()
  })

  it('a speaking wake run persists [event, assistant]', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'RUNNER-TEST wake speaks' })
    convIds.push(s.conversationId)
    await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'admin', input: { text: 'anything new?', modality: 'text' } })
    const run = (await claimNextRun({ onlyConversations: [s.conversationId], headlessSlots: HEADLESS_TEST_SLOTS }))!
    const out = await runTurn(run, { runAgent: fakeAgent('the build is red') as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(out).toMatchObject({ status: 'done', suppressed: false })
    expect((await chain(s.conversationId)).map(x => [x.role, x.origin, x.content.trim()])).toEqual([
      ['event', 'wake:admin', 'anything new?'],
      ['assistant', null, 'the build is red']
    ])
  })

  // Cycle 74: `context: 'light'` sends only the last LIGHT_CONTEXT_TURNS (4) turns of history.
  it('a light-context wake over a 10-turn thread sends the model at most 4 prior turns', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'RUNNER-TEST wake light' })
    convIds.push(s.conversationId)
    for (let i = 0; i < 10; i++) {
      await appendMessages(s.conversationId, [
        { role: 'user', content: `q${i}`, modality: 'text' },
        { role: 'assistant', content: `a${i}`, modality: 'text' }
      ])
    }
    await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'light', input: { text: 'anything new?', modality: 'text', context: 'light' } })
    const run = (await claimNextRun({ onlyConversations: [s.conversationId], headlessSlots: HEADLESS_TEST_SLOTS }))!
    let sent: { role: string, content: unknown }[] = []
    const capture = async function* (m: { role: string, content: unknown }[]) {
      sent = m
      yield { type: 'text-delta', text: 'NO_REPLY' } as const
      yield { type: 'done' } as const
    }
    await runTurn(run, { runAgent: capture as never, assemble: noAssemble as never, hub: new StreamHub() })
    const users = sent.filter(x => x.role === 'user')
    expect(users.length).toBeLessThanOrEqual(5) // 4 prior turns + the current prompt
    expect(users.slice(0, -1).map(x => x.content)).toEqual(['q6', 'q7', 'q8', 'q9'])
  })

  it('a full-context wake over the same kind of thread still sends every turn', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'RUNNER-TEST wake full' })
    convIds.push(s.conversationId)
    for (let i = 0; i < 10; i++) {
      await appendMessages(s.conversationId, [
        { role: 'user', content: `q${i}`, modality: 'text' },
        { role: 'assistant', content: `a${i}`, modality: 'text' }
      ])
    }
    await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'full', input: { text: 'anything new?', modality: 'text' } })
    const run = (await claimNextRun({ onlyConversations: [s.conversationId], headlessSlots: HEADLESS_TEST_SLOTS }))!
    let sent: { role: string }[] = []
    const capture = async function* (m: { role: string }[]) {
      sent = m
      yield { type: 'text-delta', text: 'NO_REPLY' } as const
      yield { type: 'done' } as const
    }
    await runTurn(run, { runAgent: capture as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(sent.filter(x => x.role === 'user')).toHaveLength(11)
  })

  // Controller ruling (carried from Task 7's concern, tightened in fix round 1): a suppressed
  // NO_REPLY wake used to stream its text live to any subscribed socket before being dropped,
  // AND (separately) the usage re-emit below used to open an EMPTY assistant message live for
  // every wake run — ttftMs gets set from the withheld transcript even though nothing was ever
  // actually streamed, so the old guard (`ttftMs !== undefined`) fired regardless. A wake run's
  // assistant TEXT and REASONING must never reach a live subscriber, and with nothing else
  // streamable (no real usage event, as this fake agent never emits one), NO chunk frame at all
  // should reach the subscriber — only the `persisted` re-read shows the (real or absent) reply.
  it('a subscribed sink on a wake run that replies NO_REPLY receives no chunk frames at all', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'RUNNER-TEST wake stream' })
    convIds.push(s.conversationId)
    await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'stream-test', input: { text: 'anything new?', modality: 'text' } })
    const run = (await claimNextRun({ onlyConversations: [s.conversationId], headlessSlots: HEADLESS_TEST_SLOTS }))!
    const hub = new StreamHub()
    const got: string[] = []
    hub.subscribe(s.conversationId, { id: 'watcher', send: (d) => { if (typeof d === 'string') got.push(d) } })
    const out = await runTurn(run, { runAgent: fakeAgent('NO_REPLY') as never, assemble: noAssemble as never, hub })
    expect(out.suppressed).toBe(true)
    const chunkTypes = got.filter(f => JSON.parse(f).type === 'chunk').map(f => JSON.parse(f).chunk.type)
    // Nothing streamable happened (text withheld, no usage event) — no start/finish either.
    expect(chunkTypes).toEqual([])
  })

  it('withholds reasoning frames on a wake run too, even for a real (non-suppressed) reply', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'RUNNER-TEST wake reasoning' })
    convIds.push(s.conversationId)
    await createRun({ conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'wake', profile: 'headless', wakeReason: 'reasoning-test', input: { text: 'anything new?', modality: 'text' } })
    const run = (await claimNextRun({ onlyConversations: [s.conversationId], headlessSlots: HEADLESS_TEST_SLOTS }))!
    const thinksThenReplies = async function* () {
      yield { type: 'reasoning-delta', text: 'thinking it over' } as const
      yield { type: 'text-delta', text: 'nothing new' } as const
      yield { type: 'done' } as const
    }
    const hub = new StreamHub()
    const got: string[] = []
    hub.subscribe(s.conversationId, { id: 'watcher', send: (d) => { if (typeof d === 'string') got.push(d) } })
    const out = await runTurn(run, { runAgent: thinksThenReplies as never, assemble: noAssemble as never, hub })
    expect(out.suppressed).toBe(false) // a real reply, not NO_REPLY — still must not stream live
    const chunkTypes = got.filter(f => JSON.parse(f).type === 'chunk').map(f => JSON.parse(f).chunk.type)
    expect(chunkTypes).toEqual([])
  })

  // Fix round 1 ruling: a wake run streams ONLY state frames. With D4 a silent wake sends no
  // `persisted` re-read, so a tool/usage chunk that opened a live assistant message would stay
  // on screen as a ghost — and strand the viewer's next re-read (screen N+1 vs server N).
  it('a wake run with tool calls and usage streams no chunk or user-message frames, only state', async () => {
    const { run, conversationId } = await wakeRun('tools-live')
    const hub = new StreamHub()
    const got: string[] = []
    hub.subscribe(conversationId, { id: 'watcher', send: (d) => {
      if (typeof d === 'string') got.push(d)
    } })
    const toolsThenSilent = async function* () {
      yield { type: 'tool-start', callId: 'c1', name: 'search_tasks', args: {} } as const
      yield { type: 'tool-result', callId: 'c1', name: 'search_tasks', summary: 'listed tasks (0)', args: {}, result: { hits: 0 }, kind: 'read' } as const
      yield { type: 'usage', inputTokens: 10, outputTokens: 2, totalTokens: 12 } as const
      yield { type: 'text-delta', text: 'NO_REPLY' } as const
      yield { type: 'done' } as const
    }
    const out = await runTurn(run, { runAgent: toolsThenSilent as never, assemble: noAssemble as never, hub })
    expect(out).toMatchObject({ status: 'done', suppressed: true })
    const types = got.map(f => JSON.parse(f).type)
    expect(types).not.toContain('chunk')
    expect(types).not.toContain('user-message')
    expect(types).toContain('state') // state still streams (the tool indicator)
    expect(await rows(conversationId)).toEqual([])
  })

  // Fix round 1 ruling: an empty (trimmed) final reply on a wake is silent too — nothing persists
  // and the job reads it as 'silent', matching the rescue path.
  it('a wake whose final reply is empty persists nothing and is silent', async () => {
    const { run, conversationId } = await wakeRun('empty-reply')
    const blank = async function* () {
      yield { type: 'text-delta', text: '   ' } as const
      yield { type: 'done' } as const
    }
    const afterPersist = vi.fn()
    const out = await runTurn(run, { runAgent: blank as never, assemble: noAssemble as never, hub: new StreamHub(), afterPersist })
    expect(out).toMatchObject({ status: 'done', suppressed: true })
    expect(jobOutcomeOf(out).outcome).toBe('silent')
    expect(await rows(conversationId)).toEqual([])
    expect(afterPersist).not.toHaveBeenCalled()
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

  it('cycle 75: an inbound-iMessage run stamps input.origin on its user row only — normal and rescue paths', async () => {
    const origin = 'imessage:iMessage;-;+15551234567'
    const ok = await queued('from my phone', { input: { text: 'from my phone', modality: 'text', origin } })
    await runTurn(ok.run, { runAgent: fakeAgent('got it') as never, assemble: noAssemble as never, hub: new StreamHub() })
    const r1 = await rows(ok.conversationId)
    expect(r1.find(x => x.role === 'user')?.origin).toBe(origin)
    expect(r1.find(x => x.role === 'assistant')?.origin).toBeNull()

    const bad = await queued('phone then boom', { input: { text: 'phone then boom', modality: 'text', origin } })
    const boom = async function* () {
      yield { type: 'text-delta', text: 'partial ' } as const
      throw new Error('model died')
    }
    await runTurn(bad.run, { runAgent: boom as never, assemble: noAssemble as never, hub: new StreamHub() })
    const r2 = await rows(bad.conversationId)
    expect(r2.find(x => x.role === 'user')?.origin).toBe(origin)
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

  // Cycle 74 D4 (replaces cycle 73's "rescues only the event row"): the event row is
  // meaningless alone, so a rescued wake with a suppressed or empty reply persists nothing.
  it('a wake that throws after NO_REPLY rescues nothing', async () => {
    const { run, conversationId } = await wakeRun('rescue-silent')
    const afterPersist = vi.fn()
    const out = await runTurn(run, { runAgent: throwsAfter('NO_REPLY ') as never, assemble: noAssemble as never, hub: new StreamHub(), afterPersist })
    expect(out.status).toBe('failed')
    expect(await rows(conversationId)).toEqual([])
    expect(afterPersist).not.toHaveBeenCalled()
  })

  it('a wake that throws before saying anything rescues nothing', async () => {
    const { run, conversationId } = await wakeRun('rescue-empty')
    // eslint-disable-next-line require-yield -- the model dies before its first token
    const boom = async function* () {
      throw new Error('model died')
    }
    const out = await runTurn(run, { runAgent: boom as never, assemble: noAssemble as never, hub: new StreamHub() })
    expect(out.status).toBe('failed')
    expect(await rows(conversationId)).toEqual([])
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

  describe('steers drained mid-turn are persisted as user rows, in order (spec §4.4)', () => {
    it('success: [question, steer, reply] in one chain, ids name the question and the reply', async () => {
      const { run, conversationId } = await queued('the question')
      const out = await runTurn(run, { runAgent: steeredAgent(run.id, conversationId, 'actually, also this', { reply: 'done' }) as never, assemble: noAssemble as never, hub: new StreamHub() })
      expect(out.status).toBe('done')
      const c = await chain(conversationId)
      expect(c.map(x => [x.role, x.modality, x.content.trim()])).toEqual([
        ['user', 'text', 'the question'],
        ['user', 'text', 'actually, also this'],
        ['assistant', 'text', 'first done']
      ])
      expect(out.userMessageId).toBe(c[0]!.id)
      expect(out.assistantMessageId).toBe(c[2]!.id)
    })

    it('a drained steer survives a run that produced no reply at all', async () => {
      const { run, conversationId } = await queued('quiet question')
      const silent = async function* (_m: unknown, ctx: { drainSteer?: () => Promise<string[]> }) {
        await pushSteer(run.id, conversationId, 'hello?', 'user')
        await ctx.drainSteer!()
        yield { type: 'done' } as const
      }
      const out = await runTurn(run, { runAgent: silent as never, assemble: noAssemble as never, hub: new StreamHub() })
      expect(out.status).toBe('done')
      expect((await chain(conversationId)).map(x => [x.role, x.content])).toEqual([['user', 'quiet question'], ['user', 'hello?']])
      expect(out.assistantMessageId).toBeUndefined()
    })

    it('rescue (throw after the drain): [question, steer, partial reply]', async () => {
      const { run, conversationId } = await queued('doomed question')
      const out = await runTurn(run, { runAgent: steeredAgent(run.id, conversationId, 'wait, one more thing', { throwAfter: true }) as never, assemble: noAssemble as never, hub: new StreamHub() })
      expect(out.status).toBe('failed')
      expect((await chain(conversationId)).map(x => [x.role, x.content.trim()])).toEqual([
        ['user', 'doomed question'],
        ['user', 'wait, one more thing'],
        ['assistant', 'first']
      ])
    })

    it('rescue with a blank question keeps the steer AND the partial reply: [steer, partial]', async () => {
      // An empty question never reaches the model (handleTurn returns early), so the reachable
      // case is whitespace-only. partialTurnMessages alone would drop the reply as unattributable.
      const { run, conversationId } = await queued('   ')
      const out = await runTurn(run, { runAgent: steeredAgent(run.id, conversationId, 'are you there?', { throwAfter: true }) as never, assemble: noAssemble as never, hub: new StreamHub() })
      expect(out.status).toBe('failed')
      expect((await chain(conversationId)).map(x => [x.role, x.content.trim()])).toEqual([
        ['user', 'are you there?'],
        ['assistant', 'first']
      ])
    })

    it('a wake run keeps its event row first: [event, steer, reply]', async () => {
      const { run, conversationId } = await wakeRun('steered')
      const out = await runTurn(run, { runAgent: steeredAgent(run.id, conversationId, 'Tony chimed in', { reply: 'noted' }) as never, assemble: noAssemble as never, hub: new StreamHub() })
      expect(out.status).toBe('done')
      const c = await chain(conversationId)
      expect(c.map(x => [x.role, x.origin, x.content.trim()])).toEqual([
        ['event', 'wake:steered', 'anything new?'],
        ['user', null, 'Tony chimed in'],
        ['assistant', null, 'first noted']
      ])
      expect(out.userMessageId).toBe(c[0]!.id)
      expect(out.assistantMessageId).toBe(c[2]!.id)
    })
  })
})
