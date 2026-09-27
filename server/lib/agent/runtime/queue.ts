// enqueue → DB row; a pump claims runnable rows and executes them. Serialisation per
// conversation is the claim's job (runs.ts); this file only moves work along.
import { activeRunFor, claimNextRun, createRun, finishRun, touchRun } from './runs'
import { resolveSession } from './sessions'
import { pushSteer, requeueUnconsumed } from './inbox'
import { abortRun } from './aborts'
import { runTurn } from './runner'
import { maybeSummarizeLater } from './summarize-hook'
import { recoverStale } from './recover'
import { publishChange } from '../../../utils/live-bus'
import type { AgentRun } from '../../../db/schema'
import type { RunInput, RunOutcome, RunProfile, RunTrigger, SessionKey } from './types'

export const HEADLESS_WALL_CLOCK_MS = 300_000
export const ALIVE_BUMP_MS = 10_000

export interface EnqueueRequest {
  sessionKey: SessionKey | 'thread:new'; input: RunInput; trigger: RunTrigger; profile: RunProfile
  wakeReason?: string; modelDefId?: string | null; originSinkId?: string | null
}
export interface EnqueueResult { runId: string; conversationId: string; steered: boolean; created: boolean }

type RunFn = (run: AgentRun) => Promise<RunOutcome>

export async function enqueue(req: EnqueueRequest, deps: { run?: RunFn; kick?: boolean } = {}): Promise<EnqueueResult> {
  const { conversationId, created } = await resolveSession(req.sessionKey, { titleHint: req.input.text })
  if (req.trigger === 'user' && !created) {
    const active = await activeRunFor(conversationId)
    if (active) {
      await pushSteer(active.id, conversationId, req.input.text, 'user')
      return { runId: active.id, conversationId, steered: true, created }
    }
  }
  const run = await createRun({
    conversationId, sessionKey: created && req.sessionKey === 'thread:new' ? `thread:${conversationId}` : req.sessionKey,
    trigger: req.trigger, profile: req.profile, input: req.input,
    wakeReason: req.wakeReason ?? null, modelDefId: req.modelDefId ?? null, originSinkId: req.originSinkId ?? null
  })
  if (deps.kick !== false) kick(deps.run)
  return { runId: run.id, conversationId, steered: false, created }
}

export async function abortActive(conversationId: string): Promise<boolean> {
  const active = await activeRunFor(conversationId)
  return active ? (abortRun(active.id), true) : false
}

async function execute(run: AgentRun, runFn: RunFn, rekick: boolean): Promise<void> {
  const alive = setInterval(() => { touchRun(run.id).catch(() => {}) }, ALIVE_BUMP_MS)
  const wall = run.profile === 'headless' ? setTimeout(() => abortRun(run.id), HEADLESS_WALL_CLOCK_MS) : null
  let outcome: RunOutcome
  try {
    outcome = await runFn(run)
  } catch (err) {
    outcome = { status: 'failed', error: (err as Error).message }
  } finally {
    clearInterval(alive); if (wall) clearTimeout(wall)
  }
  await finishRun(run.id, outcome).catch(err => console.error('[runtime] finishRun failed:', err))
  if (outcome.status === 'aborted') await requeueUnconsumed(run).catch(() => null)
  publishChange({ resource: 'agentRun', action: 'updated', id: run.id })
  if (rekick) kick(runFn)
}

/** Claim and START everything currently runnable; returns how many were started. */
/** `rekick: false` + `onlyConversations` is the test seam: the dev DB is shared, and an unscoped
 *  re-pump after a test run finishes would claim (and fake-execute) other sessions' queued runs. */
export async function pumpOnce(opts: { onlyConversations?: string[]; run?: RunFn; rekick?: boolean } = {}): Promise<number> {
  const runFn = opts.run ?? ((r: AgentRun) => runTurn(r, { afterPersist: maybeSummarizeLater }))
  let started = 0
  for (;;) {
    const run = await claimNextRun({ onlyConversations: opts.onlyConversations })
    if (!run) return started
    started++
    void execute(run, runFn, opts.rekick !== false)
  }
}

let pumping = false
let again = false
function kick(run?: RunFn): void {
  if (pumping) { again = true; return }
  pumping = true
  setImmediate(async () => {
    try { do { again = false; await pumpOnce({ run }) } while (again) }
    catch (err) { console.error('[runtime] pump failed:', err) }
    finally { pumping = false }
  })
}

// The periodic tick's own overlap guard. Independent of `pumping` above: `kick` coalesces
// concurrent *pump* requests into one more pass; `ticking` stops two 5s timer firings (or a
// timer firing while a test calls workerTick directly) from running `recoverStale` twice at
// once, which would just be duplicate work, not a race.
let ticking = false

/**
 * The worker's periodic unit of work: recover anything the previous process left dangling in
 * `onlyConversations`'s scope, then pump. Controller ruling (Task 2 review): boot recovery
 * alone leaves a fast-restart (<60s) window where a dead 'running' row blocks its conversation
 * forever, since `enqueue` steers into whatever `activeRunFor` reports as running — so this
 * must also run on every tick, not only at startup.
 *
 * Test seam: called directly with `onlyConversations` so a DB test can prove the periodic
 * path recovers a stale run without ever touching another session's rows — in that scoped
 * form the follow-up pump is also scoped (`pumpOnce({ onlyConversations, rekick: false })`),
 * never the unscoped `kick()` the production (no-args) tick uses.
 */
export async function workerTick(opts: { onlyConversations?: string[] } = {}): Promise<boolean> {
  if (ticking) return false
  ticking = true
  try {
    await recoverStale({ onlyConversations: opts.onlyConversations })
    if (opts.onlyConversations) await pumpOnce({ onlyConversations: opts.onlyConversations, rekick: false })
    else kick()
  } catch (err) {
    console.error('[runtime] worker tick failed:', err)
  } finally {
    ticking = false
  }
  return true
}

let timer: ReturnType<typeof setInterval> | null = null
export function startWorker(): void { if (!timer) { timer = setInterval(() => { void workerTick() }, 5_000); kick() } }
export function stopWorker(): void { if (timer) clearInterval(timer); timer = null }
