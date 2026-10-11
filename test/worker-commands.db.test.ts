// Cycle 81 Task 4 — the web↔worker commands, end to end across two processes. The "worker" is a
// child process (test/fixtures/worker-commands/cmd-child.ts) answering commands with the REAL
// handlers apps/worker wires (commandHandlers + coreCommandDeps) and executing runs through the
// queue's own execute path; this process plays the web: it reads the run's frames off the bus and
// sends commands, exactly as ws.ts / the API routes do.
//   - an exec-style approval (gmail_send-shaped nonce pin) approved from the web resumes the run;
//     denied → denied; nobody answers → auto-denied at the chat timeout;
//   - `/clear`: the abort's settled answer arrives only after the run's rescue landed, so an epoch
//     written then has every rescued row before it;
//   - undo of a task a worker run created succeeds via command; after the TTL it reports expired;
//   - presence makes isAway false in the worker; `invalidate` makes it re-read ai-registry.
//
// Shared dev DB: own bus namespace (the child gets MYMIND_BUS_NS); runs are INSERTED 'running'
// (never 'queued', so no dev worker can claim them); every conversation/run/message/task row is
// created here and deleted in afterAll, and this namespace's worker_commands rows too. The ai_config
// and channels rows are only READ. The child is killed by its own PID.
process.loadEnvFile('.env')
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.stubGlobal('useRuntimeConfig', () => ({ databaseUrl: process.env.DATABASE_URL }))

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { useDb } from '@mymind/core/db'
import { agentRuns, conversationMessages, conversations, tasks, workerCommands } from '@mymind/core/db/schema'
import { resolveSession } from '@mymind/core/lib/agent/runtime/sessions'
import { readRunEvents, type HubFrame } from '@mymind/core/lib/bus/events'
import { sendCommand } from '@mymind/core/lib/bus/commands'
import { closeListener, listenReady } from '@mymind/core/lib/bus/listen'
import { BUS_NS_ENV, setBusNs } from '@mymind/core/lib/bus/ns'
import { redeemUndo } from '@mymind/core/lib/agent/undo-remote'
import { clearConversationContext } from '../server/services/conversation-clear'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CHILD = join(HERE, 'fixtures/worker-commands/cmd-child.ts')
const TSX_ESM = pathToFileURL(createRequire(join(ROOT, 'package.json')).resolve('tsx/esm')).href
const NS = `wc${randomUUID().slice(0, 8)}`
const APPROVAL_TIMEOUT_MS = 3_000
const convIds: string[] = []
let child: ChildProcess
const lines: string[] = []

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until<T>(fn: () => T | Promise<T>, ms = 20_000, step = 25): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`until: timed out (child said: ${lines.slice(-5).join(' | ')})`)
    await sleep(step)
  }
}
/** Send one stdin line to the child and wait for the first NEW stdout line matching `re`. */
async function ask(line: string, re: RegExp, ms = 20_000): Promise<string> {
  const from = lines.length
  child.stdin!.write(`${line}\n`)
  return until(() => lines.slice(from).find(l => re.test(l)), ms)
}

beforeAll(async () => {
  setBusNs(NS)
  await listenReady()
  child = spawn(process.execPath, ['--import', TSX_ESM, CHILD], {
    cwd: ROOT,
    env: { ...process.env, [BUS_NS_ENV]: NS, APPROVAL_TIMEOUT_MS: String(APPROVAL_TIMEOUT_MS) },
    stdio: ['pipe', 'pipe', 'inherit']
  })
  createInterface({ input: child.stdout! }).on('line', l => lines.push(l))
  const ready = await until(() => lines.find(l => l.startsWith('READY ')), 60_000)
  expect(Number(ready.split(' ')[1])).toBe(child.pid)
}, 90_000)

afterAll(async () => {
  if (child && child.exitCode === null) child.kill('SIGKILL')
  const db = useDb()
  await db.delete(agentRuns).where(inArray(agentRuns.conversationId, convIds))
  await db.delete(conversationMessages).where(inArray(conversationMessages.conversationId, convIds))
  await db.delete(conversations).where(inArray(conversations.id, convIds))
  await db.delete(tasks).where(like(tasks.title, 'WORKERCMD-TEST task %'))
  await db.delete(workerCommands).where(eq(workerCommands.ns, NS))
  await closeListener()
  setBusNs(null)
})

/** A socket-originated chat run, already 'running' (the child takes ownership and executes it). */
async function socketRun(text: string) {
  const s = await resolveSession('thread:new', { titleHint: 'WORKERCMD-TEST' })
  convIds.push(s.conversationId)
  const [run] = await useDb().insert(agentRuns).values({
    conversationId: s.conversationId, sessionKey: `thread:${s.conversationId}`, trigger: 'user', profile: 'interactive',
    input: { text, modality: 'text' }, originSinkId: `sink-${randomUUID()}`,
    status: 'running', owner: 'test-parent', claimedAt: sql`now()`, aliveAt: sql`now()`
  }).returning()
  return { runId: run!.id, conversationId: s.conversationId }
}
const frames = async (runId: string) => (await readRunEvents({ runId })).map(r => r.payload as HubFrame)
/** Is the task live (not soft-deleted — deleteTask sets deleted_at)? */
const taskLive = async (id: string) => (await useDb().select({ deletedAt: tasks.deletedAt }).from(tasks).where(eq(tasks.id, id)))[0]?.deletedAt === null
const replyOf = async (conversationId: string) => (await useDb().select().from(conversationMessages)
  .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.role, 'assistant')))).map(m => m.content).join('\n')

describe('approvals across processes', () => {
  it('the card comes off the bus with the full request (no nonce); approving it from the web resumes the run, and the nonce pin still binds', async () => {
    const { runId, conversationId } = await socketRun('send it')
    const done = ask(`run ${runId} approval`, new RegExp(`^RUNDONE ${runId}`))
    const card = await until(async () => (await frames(runId)).find(f => f.type === 'approval'))
    expect(card).toEqual({ type: 'approval', requestId: expect.any(String), tool: 'fake_send', title: 'Send this?', command: 'send draft-v1', proposedPattern: '', logSummary: 'fake_send: draft-v1', allowlistable: false, callId: 'call-fake_send', args: {} })
    const { requestId } = card as { requestId: string }
    expect(await sendCommand('approval-decision', { requestId, approved: true }, { awaitResult: true })).toBe(true)
    expect(await done).toBe(`RUNDONE ${runId} done`)
    expect(await replyOf(conversationId)).toContain('RESULT:{"sent":true}')
    expect((await frames(runId)).some(f => f.type === 'approval-resolved' && f.requestId === requestId)).toBe(true)
    // Answered once: a second decision (another tab) finds nothing pending.
    expect(await sendCommand('approval-decision', { requestId, approved: false }, { awaitResult: true })).toBe(false)
  }, 60_000)

  it('denying it from the web returns a denied result to the run', async () => {
    const { runId, conversationId } = await socketRun('send it')
    const done = ask(`run ${runId} approval`, new RegExp(`^RUNDONE ${runId}`))
    const card = await until(async () => (await frames(runId)).find(f => f.type === 'approval')) as { requestId: string }
    await sendCommand('approval-decision', { requestId: card.requestId, approved: false }, { awaitResult: true })
    expect(await done).toBe(`RUNDONE ${runId} done`)
    expect(await replyOf(conversationId)).toContain('RESULT:{"denied":true}')
  }, 60_000)

  it('nobody answers → the chat approval auto-denies at its timeout and the card is resolved', async () => {
    const { runId, conversationId } = await socketRun('send it')
    const t0 = Date.now()
    const done = ask(`run ${runId} approval`, new RegExp(`^RUNDONE ${runId}`), 30_000)
    expect(await done).toBe(`RUNDONE ${runId} done`)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(APPROVAL_TIMEOUT_MS)
    expect(await replyOf(conversationId)).toContain('RESULT:{"denied":true}')
    const fs = await frames(runId)
    const card = fs.find(f => f.type === 'approval') as { requestId: string }
    expect(fs.some(f => f.type === 'approval-resolved' && f.requestId === card.requestId)).toBe(true)
  }, 60_000)
})

describe('/clear across processes', () => {
  it('the abort answers settled only after the run unwound: an epoch written then has every rescued row before it', async () => {
    const { runId, conversationId } = await socketRun('CLEAR-ME talk for a while')
    const done = ask(`run ${runId} slow`, new RegExp(`^RUNDONE ${runId}`), 40_000)
    // Mid-turn: some text has streamed.
    await until(async () => (await frames(runId)).filter(f => f.type === 'chunk').length >= 3)
    const res = await sendCommand('abort', { conversationId }, { awaitResult: true })
    expect(res).toEqual({ settled: true })
    // What ws.ts does next — only on settled:true.
    await clearConversationContext(conversationId)
    expect(await done).toBe(`RUNDONE ${runId} aborted`)
    await sleep(300)
    const [conv] = await useDb().select().from(conversations).where(eq(conversations.id, conversationId))
    const rows = await useDb().select().from(conversationMessages).where(eq(conversationMessages.conversationId, conversationId))
    // The runner's rescue persisted the question + partial reply — and BEFORE the epoch.
    expect(rows.map(r => r.role).sort()).toEqual(['assistant', 'user'])
    expect(rows.find(r => r.role === 'user')!.content).toContain('CLEAR-ME')
    for (const r of rows) expect(r.createdAt.getTime()).toBeLessThan(conv!.contextEpochAt!.getTime())
  }, 60_000)

  it('nothing running on the thread → settled at once', async () => {
    const s = await resolveSession('thread:new', { titleHint: 'WORKERCMD-TEST' })
    convIds.push(s.conversationId)
    expect(await sendCommand('abort', { conversationId: s.conversationId }, { awaitResult: true })).toEqual({ settled: true })
  })
})

describe('undo across processes', () => {
  it('undo of a task a worker run created succeeds via the undo command', async () => {
    const { runId } = await socketRun('add a task')
    const undoLine = ask(`run ${runId} task`, /^UNDO /)
    const [, token, taskId] = (await undoLine).split(' ')
    await until(() => lines.some(l => l.startsWith(`RUNDONE ${runId}`)))
    expect(await taskLive(taskId!)).toBe(true)
    // The web process never saw this token: redeemUndo must go to the worker for it.
    expect(await redeemUndo(token!)).toEqual({ ok: true })
    expect(await taskLive(taskId!)).toBe(false)
    // Used: a second redeem is the worker's own refusal, not a silent success.
    expect(await redeemUndo(token!)).toEqual({ ok: false, reason: 'undo expired or already used' })
  }, 60_000)

  it('after the TTL the worker reports it expired (and nothing is undone)', async () => {
    expect(await ask('undo-ttl 300', /^OK$/)).toBe('OK')
    try {
      const { runId } = await socketRun('add a task')
      const [, token, taskId] = (await ask(`run ${runId} task`, /^UNDO /)).split(' ')
      await sleep(500)
      expect(await redeemUndo(token!)).toEqual({ ok: false, reason: 'undo expired or already used' })
      expect(await taskLive(taskId!)).toBe(true)
    } finally {
      await ask('undo-ttl 0', /^OK$/).catch(() => {})
    }
  }, 60_000)
})

describe('presence and caches', () => {
  it('presence makes isAway false in the worker', async () => {
    expect(await ask('away', /^AWAY /)).toBe('AWAY true') // a fresh process has seen no activity
    await sendCommand('presence', { lastActiveAt: Date.now() }, { awaitResult: true })
    expect(await ask('away', /^AWAY /)).toBe('AWAY false')
  })

  it('invalidate makes the worker re-read the ai-registry config', async () => {
    expect(await ask('prime-ai', /^OK$/)).toBe('OK')
    expect(await ask('ai', /^AI /)).toBe('AI sentinel') // served from the cache, no DB read
    await sendCommand('invalidate', { cache: 'ai-registry' }, { awaitResult: true })
    expect(await ask('ai', /^AI /)).toBe('AI db')
  })
})
