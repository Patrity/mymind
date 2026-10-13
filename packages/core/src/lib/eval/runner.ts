// Cycle 85 (spec §3.3/§3.4): the eval runner — one suite run, attempt by attempt, each in its own
// fake world (world.ts), scored (matcher.ts / score.ts) and written to eval_results.
//
// An attempt (runAttempt):
//   1. installs a world for the case (tenant schema, fixtures, scripted approver; network = only the
//      model gateway origins, compared exactly — provenance.ts gatewayAllow);
//   2. inside it, seeds channel config (only a case that asks), starts the case — a chat turn on a new
//      thread, or a workstream — writes `setup.files` into its workspace (offline sandbox), and DRIVES
//      the attempt itself: it claims the world's runnable runs (claimNextRun — in-world, so only the
//      tenant's rows) and executes each through the runtime's own path (queue.ts executeClaimedRun),
//      each behind an eval pool slot (pool.ts: half of the model's maxInFlight). Never the worker's
//      tick, kick or pump: those carry process-wide single-flight flags shared with Tony's work;
//   3. stops at the 10-minute wall cap (every run of the attempt is aborted and unwinds; the attempt
//      fails), when the case's work is over, or when the worker drains;
//   4. world.settle() → FAIL the attempt if the capture log was truncated or the tenant drifted →
//      read the tool log, judge the outcome (rubric cases), score → world.dispose() (always).
// Results are written OUTSIDE the world, to public eval_results, and published live (`eval`).
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { useDb } from '../../db'
import { agentRuns, conversationMessages, evalCases, evalResults, evalRuns, runEvents, type AgentRun, type EvalCaseRow, type EvalRunRow } from '../../db/schema'
import { publishChange } from '../../utils/live-bus'
import { claimNextRun, BOOT_ID } from '../agent/runtime/runs'
import { claimingIsStopped, enqueue, executeClaimedRun } from '../agent/runtime/queue'
import { abortRun } from '../agent/runtime/aborts'
import { runTurn, type RunnerDeps } from '../agent/runtime/runner'
import { poolLimits } from '../agent/runtime/pools'
import { VOICE_TUNING } from '../voice/tuning'
import { buildOutcomeEvidence, outcomeMet, verifyOutcome, type OutcomeVerdict } from '../agent/judge/outcome'
import { loadConfig } from '../ai/registry/store'
import { installEvalWorld, cleanupEvalRun, type EvalWorld } from './world'
import { assertEvalConnectionsFit } from './tenant'
import { readEvalSettingsFresh } from '../agent/agent-settings'
import { approvalChecks, contentMatches, forbiddenHits, matchActions, type EvalToolCall, type MatchMode } from './matcher'
import { attemptHitForbidden, scoreAttempt, summarizeRun, CASE_PASS_MEAN, type CaseForSummary } from './score'
import { scoringSpecOf } from './scoring-spec'
import { createEvalPool, evalPool, evalShareOf, type EvalPool } from './pool'
import { casePromptHash, gatewayAllow, gatewayOriginsFrom, gitSha, modelLabel, primaryModelFrom, runPromptHash, toolsHash } from './provenance'
import type { EvalSetup } from './setup'
import type { EvalAttemptOutcome, EvalAttemptScoring, EvalRunParams, EvalRunSummary, EvalToolLogEntry, EvalWorkstreamOutcome } from '../../shared/types/eval'
import type { CapturedWrite } from './context'
import type { OutcomeVerification } from '../../shared/types/workstreams'

/** Per-attempt wall cap (global constraint). */
export const ATTEMPT_WALL_MS = 10 * 60_000
/** How long an aborted attempt's runs get to unwind before the attempt gives up on them. */
export const UNWIND_MS = 30_000
/** Liveness of a running eval run (eval_runs.alive_at); stale past EVAL_RUN_STALE_MS = a crash. */
export const EVAL_RUN_BEAT_MS = 15_000
export const EVAL_RUN_STALE_MS = 2 * 60_000
/** Final fix wave (I3): attempts of one run in parallel, whatever the settings say. */
export const EVAL_MAX_CONCURRENCY = 4
/** Final fix wave (I4): the error a run over its token budget ends with (status failed). */
export const BUDGET_STOP_PREFIX = 'stopped: budget'
const ARG_STRING_CAP = 2_000
const RESULT_CAP = 500
const FINAL_TEXT_CAP = 20_000

export interface EvalRunnerOptions {
  /** How a claimed run executes (runtime/runner.ts runTurn deps) — tests pass a fake model. */
  runner?: RunnerDeps
  /** The outcome judge for rubric cases (default judge/outcome.ts verifyOutcome, on the judge chain). */
  verify?: (evidence: Parameters<typeof verifyOutcome>[0], o?: { signal?: AbortSignal }) => Promise<OutcomeVerdict>
  /** Writes setup.files into a workspace (default: the world's offline sandbox). */
  writeFiles?: (workspaceId: string, files: Record<string, string>) => Promise<void>
  /** Per-attempt wall cap (default ATTEMPT_WALL_MS). */
  wallMs?: number
  /** Model id → maxInFlight (default runtime/pools.ts poolLimits). */
  poolLimits?: () => Promise<Record<string, number>>
  pool?: EvalPool
  /** Driver poll while runs are in flight (default 250 ms). */
  pollMs?: number
  /** Overrides the gateway allow-list (tests). */
  allowNetwork?: (url: string) => boolean
  /** Attempts of one run started at once (default: settings `eval.concurrency`; never above
   *  EVAL_MAX_CONCURRENCY). */
  concurrency?: number
  /** The run's token budget (default: settings `eval.maxTokensPerRun`). */
  maxTokensPerRun?: number
  /** Postgres connection stats for the run-start check (default: the server's) — a test seam. */
  connectionStats?: () => Promise<import('./tenant').PgConnectionStats>
  /** Heartbeat interval (default EVAL_RUN_BEAT_MS). */
  beatMs?: number
  /** How long aborted runs get to unwind before their slots are force-released (default UNWIND_MS). */
  unwindMs?: number
  /** A case's system-prompt hash (default provenance.ts casePromptHash) — a test seam. */
  promptHash?: (c: EvalCaseRow) => Promise<string>
  /** Runs right after a world is installed, before the drift check — a test seam. */
  afterInstall?: (world: EvalWorld) => Promise<void>
  /** Writes one attempt's result (default: insert into eval_results + publish) — a test seam. */
  writeResult?: (runId: string, r: AttemptRecord) => Promise<void>
}

// ── Reading an attempt's world ───────────────────────────────────────────────────────────────

const CALL_CHUNKS = ['tool-input-available', 'tool-output-available', 'tool-output-error', 'tool-output-denied', 'data-output_warning']

function capArgs(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { _raw: typeof v === 'string' ? v.slice(0, ARG_STRING_CAP) : JSON.stringify(v ?? null).slice(0, ARG_STRING_CAP) }
  const cap = (x: unknown): unknown => typeof x === 'string' ? (x.length > ARG_STRING_CAP ? `${x.slice(0, ARG_STRING_CAP)}…` : x)
    : Array.isArray(x) ? x.map(cap)
      : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, cap(y)])) : x
  return cap(v) as Record<string, unknown>
}
const oneLine = (s: string, n = RESULT_CAP) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }

/** The world's tool calls in call order (every thread — a coordinator's children too). In-world. */
export async function readToolLog(ns: string): Promise<EvalToolLogEntry[]> {
  const chunk = sql`${runEvents.payload}->'chunk'`
  const rows = await useDb().select({
    run: runEvents.runId, conv: runEvents.conversationId, c: sql<Record<string, unknown>>`${chunk}`
  }).from(runEvents)
    .where(and(eq(runEvents.ns, ns), eq(runEvents.type, 'chunk'), sql`${chunk}->>'type' in (${sql.join(CALL_CHUNKS.map(t => sql`${t}`), sql`, `)})`))
    .orderBy(asc(runEvents.id)).limit(20_000)
  const byId = new Map<string, EvalToolLogEntry>()
  const order: string[] = []
  for (const r of rows) {
    const c = r.c ?? {}
    const cid = String(c.toolCallId ?? c.id ?? '')
    if (!cid) continue
    const id = `${r.run ?? ''}\u0000${cid}`
    const t = c.type
    if (t === 'tool-input-available') {
      if (byId.has(id)) continue
      byId.set(id, { tool: String(c.toolName ?? '?'), args: capArgs(c.input), status: 'pending', result: '', conversationId: r.conv })
      order.push(id)
      continue
    }
    const e = byId.get(id)
    if (!e) continue
    if (t === 'tool-output-available') {
      const o = (c.output ?? {}) as { summary?: unknown; value?: unknown }
      e.status = 'ok'
      e.result = oneLine([typeof o.summary === 'string' ? o.summary : '', o.value === undefined ? '' : JSON.stringify(o.value)].filter(Boolean).join(' — '))
    } else if (t === 'tool-output-error') { e.status = 'error'; e.result = oneLine(String(c.errorText ?? 'error')) } else if (t === 'tool-output-denied') { e.status = 'denied'; e.result = 'denied' } else if (t === 'data-output_warning') {
      const d = (c.data ?? {}) as { source?: unknown; unverified?: unknown }
      e.flagged = typeof d.source === 'string' ? d.source : 'web'
      if (d.unverified === true) e.unverified = true
    }
  }
  return order.map(id => byId.get(id)!)
}

async function lastAssistantText(conversationId: string): Promise<string | null> {
  const [m] = await useDb().select({ content: conversationMessages.content }).from(conversationMessages)
    .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.role, 'assistant')))
    .orderBy(desc(conversationMessages.createdAt)).limit(1)
  return m?.content?.trim() || null
}

async function worldTokens(): Promise<number> {
  const r = await useDb().execute(sql`select coalesce(sum(nullif(usage->>'totalTokens', '')::numeric), 0)::bigint as n from agent_runs`)
  return Number((r.rows[0] as { n?: unknown } | undefined)?.n ?? 0)
}

// ── Driving an attempt (in-world) ────────────────────────────────────────────────────────────

interface Root { conversationId: string; workstreamId: string | null; workspaceId: string | null }

async function seedChannels(ch: NonNullable<EvalSetup['channels']>): Promise<void> {
  const { loadChannelsConfig, saveChannelsConfig } = await import('../channels/config')
  const c = await loadChannelsConfig()
  const h = ch.imessage?.handle
  await saveChannelsConfig({
    ...c,
    imessage: h ? { ...c.imessage, enabled: true, serverUrl: 'http://bluebubbles.eval.invalid', allowedHandles: [h], defaultHandle: h, defaultChatGuid: `iMessage;-;${h}` } : c.imessage,
    email: ch.email ? { enabled: true, to: ch.email.to } : c.email
  })
}

/** Writes files with the workspace write script, in the world's OFFLINE sandbox (eval worlds never
 *  get a networked container). */
export async function sandboxWriteFiles(workspaceId: string, files: Record<string, string>): Promise<void> {
  const [{ workspaceRuntime }, { WRITE_SCRIPT }] = await Promise.all([import('../sandbox/runtime'), import('../sandbox/fs-ops')])
  for (const [path, content] of Object.entries(files)) {
    const r = await workspaceRuntime().manager.exec(workspaceId, WRITE_SCRIPT, { input: JSON.stringify({ path, content }), timeoutSec: 60, offline: true })
    if (r.exitCode !== 0) throw new Error(`setup.files: writing ${path} failed (${oneLine(r.stderr || r.stdout, 200) || `exit ${r.exitCode}`})`)
  }
}

async function startCase(c: EvalCaseRow, setup: EvalSetup, o: { model: string | null; writeFiles: NonNullable<EvalRunnerOptions['writeFiles']> }): Promise<Root> {
  if (setup.channels) await seedChannels(setup.channels)
  const files = setup.files && Object.keys(setup.files).length ? setup.files : null
  if (c.surface === 'workstream') {
    const { startWorkstream } = await import('../agent/workstreams/loop')
    const { ensureWorkstreamWorkspace } = await import('../sandbox/store')
    const ws = await startWorkstream({ goal: c.prompt, budget: { maxSteps: c.maxSteps } }, { kick: false })
    const workspaceId = (await ensureWorkstreamWorkspace(ws.id)).id
    if (files) await o.writeFiles(workspaceId, files)
    return { conversationId: ws.conversationId, workstreamId: ws.id, workspaceId }
  }
  let workspaceId: string | null = null
  if (files) {
    const { ensureHomeWorkspace } = await import('../sandbox/store')
    workspaceId = (await ensureHomeWorkspace()).id
    await o.writeFiles(workspaceId, files)
  }
  const r = await enqueue({
    sessionKey: 'thread:new', trigger: 'user', profile: 'interactive', modelDefId: o.model,
    input: { text: c.prompt, modality: 'text', maxSteps: Math.min(c.maxSteps, VOICE_TUNING.agent.maxSteps) }
  }, { kick: false })
  return { conversationId: r.conversationId, workstreamId: null, workspaceId }
}

class AttemptStopped extends Error {}

/** M1: the world was already drifted before the attempt started — nothing was run. */
class TenantDriftError extends Error {
  constructor(tables: string[]) { super(`tenant drift before the attempt: public has tables this world does not shadow (${tables.slice(0, 5).join(', ')}) — nothing was run`) }
}

/**
 * Runs the case's work in the world until it is over: a chat attempt when its thread has nothing
 * queued or running (a workstream it started is NOT driven — only its start_workstream call counts);
 * a workstream attempt when the workstream is finished, or nothing in the world can move any more
 * (attention on an ask_tony, a parked coordinator with nothing to wake it). Throws AttemptStopped on
 * the wall cap / a drain, after every run it started has unwound (bounded).
 */
async function driveAttempt(root: Root, o: {
  signal: AbortSignal; runFn: (r: AgentRun) => Promise<unknown>; pool: EvalPool; limits: Record<string, number>
  defaultModel: string | null; model: string | null; pollMs: number; unwindMs: number
  /** Out: runs that ignored the abort past unwindMs (their slots were force-released — M1). */
  stuck: string[]
}): Promise<void> {
  const inflight = new Map<string, Promise<void>>()
  const releases = new Map<string, () => void>()
  const scope = root.workstreamId ? undefined : [root.conversationId]
  const exec = (run: AgentRun) => {
    const p = (async () => {
      const { key, child } = await poolKeyOf(run, o.defaultModel)
      const release = await o.pool.acquire(key, evalShareOf(o.limits[key]), o.signal).catch(() => null)
      if (!release) {
        // Stopped while waiting for a slot: the run never started — finish it as aborted.
        const { finishRun } = await import('../agent/runtime/runs')
        await finishRun(run.id, { status: 'aborted' }).catch(() => {})
        return
      }
      releases.set(run.id, release)
      try {
        // The override replaces the reasoning head; a child keeps its subagents chain (M6).
        if (o.model && !child && run.modelDefId !== o.model) {
          await useDb().update(agentRuns).set({ modelDefId: o.model }).where(eq(agentRuns.id, run.id))
          run = { ...run, modelDefId: o.model }
        }
        await executeClaimedRun(run, o.runFn as never)
      } finally { releases.delete(run.id); release() }
    })().finally(() => inflight.delete(run.id))
    inflight.set(run.id, p)
  }
  const stopped = () => o.signal.aborted || claimingIsStopped()
  const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); o.signal.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) })
  let idle = 0
  try {
    while (!stopped()) {
      for (;;) {
        const run = await claimNextRun({ onlyConversations: scope })
        if (!run) break
        exec(run)
        if (stopped()) break
      }
      if (stopped()) break
      if (inflight.size) { idle = 0; await Promise.race([...inflight.values(), sleep(o.pollMs)]); continue }
      if (await workIsOver(root)) return
      // Nothing running, nothing claimable, the work not over: let a parked coordinator whose wait is
      // satisfied wake (the worker's sweep does this for real workstreams), then look once more.
      if (root.workstreamId) {
        const { sweepCoordinators } = await import('../agent/workstreams/coordinator')
        await sweepCoordinators().catch(err => console.warn('[eval] coordinator sweep failed:', (err as Error).message))
      }
      if (++idle >= 2) return
      await sleep(o.pollMs)
    }
    throw new AttemptStopped()
  } finally {
    if (inflight.size) {
      for (const id of inflight.keys()) abortRun(id)
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([Promise.allSettled([...inflight.values()]), new Promise<void>((r) => { timer = setTimeout(r, o.unwindMs) })])
      clearTimeout(timer)
      // Fix round 1 (M1): a run that ignored its abort must not hold an eval slot for the life of the
      // process (with a share of 1 every later attempt would time out). Its slot is force-released and
      // the attempt fails; the run's late writes fail at the disposed world's tenant pool.
      for (const id of inflight.keys()) {
        o.stuck.push(id)
        releases.get(id)?.()
        releases.delete(id)
        console.warn(`[eval] run ${id} ignored its abort for ${Math.round(o.unwindMs / 1000)} s — its eval slot was force-released`)
      }
    }
  }
}

/** The eval pool key of a claimed run: its stamped model, else — for a CHILD workstream segment — the
 *  head of its subagents chain (M6: it runs there, not on the reasoning model), else the run's default. */
export async function poolKeyOf(run: AgentRun, defaultModel: string | null): Promise<{ key: string; child: boolean }> {
  let child = false
  if (run.kind === 'workstream') {
    const { workstreamForConversation } = await import('../agent/workstreams/store')
    const ws = await workstreamForConversation(run.conversationId).catch(() => null)
    if (ws?.isChild) {
      child = true
      if (!run.modelDefId) {
        const { childChain } = await import('../agent/runtime/pools')
        const head = (await childChain(ws.modelLabel).catch(() => []))[0]?.modelDefId
        if (head) return { key: head, child }
      }
    }
  }
  return { key: run.modelDefId ?? defaultModel ?? 'default', child }
}

async function workIsOver(root: Root): Promise<boolean> {
  const [open] = await useDb().select({ id: agentRuns.id }).from(agentRuns)
    .where(and(root.workstreamId ? sql`true` : eq(agentRuns.conversationId, root.conversationId), inArray(agentRuns.status, ['queued', 'running']))).limit(1)
  if (open) return false
  if (!root.workstreamId) return true
  const { getWorkstream } = await import('../agent/workstreams/store')
  const { TERMINAL_WORKSTREAM_STATES } = await import('../../shared/types/workstreams')
  const ws = await getWorkstream(root.workstreamId)
  return !ws || TERMINAL_WORKSTREAM_STATES.includes(ws.state)
}

async function finalTextOf(root: Root): Promise<string> {
  if (root.workstreamId) {
    const { getWorkstream } = await import('../agent/workstreams/store')
    const ws = await getWorkstream(root.workstreamId)
    const attention = (ws?.attention as { text?: string } | null)?.text
    const t = ws?.summary?.trim() || attention?.trim() || await lastAssistantText(root.conversationId) || ''
    return t.slice(0, FINAL_TEXT_CAP)
  }
  return ((await lastAssistantText(root.conversationId)) ?? '').slice(0, FINAL_TEXT_CAP)
}

/** Final fix wave (M4): a workstream attempt's own verification (in-world). */
async function workstreamOutcome(root: Root): Promise<EvalWorkstreamOutcome | null> {
  if (!root.workstreamId) return null
  const { getWorkstream } = await import('../agent/workstreams/store')
  const ws = await getWorkstream(root.workstreamId)
  return ws ? { state: ws.state, verification: (ws.verification as OutcomeVerification | null) ?? null, sendBacks: ws.sendBacks ?? 0 } : null
}

/** Fix round 1 (S1): whether the attempt's run ended tainted — a workstream's stored (sticky) taint, or
 *  a chat thread's taint as its next turn would start with it (the same policed-history rule run.ts
 *  seeds from). In-world. */
async function worldTaint(root: Root): Promise<{ tainted: boolean; sources: string[] }> {
  if (root.workstreamId) {
    const { getWorkstream } = await import('../agent/workstreams/store')
    const ws = await getWorkstream(root.workstreamId)
    const sources = ws?.taintSources ?? []
    return { tainted: !!ws?.tainted || sources.length > 0, sources: [...sources] }
  }
  const [{ getAgentHistory }, { applyHistoryPolicy, historyTaint }, { TAINTING_TOOL_NAMES }] = await Promise.all([
    import('../../services/conversations'), import('../agent/tool-history'), import('../agent/profile')
  ])
  const history = await getAgentHistory(root.conversationId)
  const t = historyTaint(applyHistoryPolicy(history.filter(m => m.role !== 'system') as never), TAINTING_TOOL_NAMES)
  return { tainted: t.sources.length > 0, sources: [...t.sources] }
}

/** Model calls an attempt makes outside a run's own eval slot (final fix wave):
 *  - a judge class (guard / approval / outcome) takes ONE process-wide eval slot of that class (I1) —
 *    the rest of each class's semaphore is Tony's. Its own key, so a run holding its model slot while
 *    its tool's guard waits can never deadlock;
 *  - a research subagent runs on its PARENT run's model slot (I2: one eval budget per model, turns and
 *    subagents together): the parent is blocked on the tool call, so the subagent's stream replaces the
 *    parent's rather than adding one. Several subagents of one attempt take turns (a per-attempt mutex),
 *    so an attempt never runs more model streams than the slots its runs hold. */
export function evalThrottle(pool: EvalPool): NonNullable<import('./context').EvalScope['throttle']> {
  const attemptSubagents = createEvalPool()
  return async (kind, signal) => {
    if (kind === 'subagent') return attemptSubagents.acquire('subagent', 1, signal)
    return pool.acquire(`judge:${kind}`, EVAL_JUDGE_SLOTS, signal)
  }
}

/** I1: an eval run's slots of each judge class (process-wide). */
export const EVAL_JUDGE_SLOTS = 1

// ── One attempt ──────────────────────────────────────────────────────────────────────────────

export interface AttemptRecord {
  caseId: string
  attempt: number
  score: number
  passed: boolean
  forbidden: boolean
  failed: string | null
  toolLog: EvalToolLogEntry[]
  finalText: string
  outcome: EvalAttemptOutcome
  captured: CapturedWrite[]
  durationMs: number
  tokens: number
}

export interface AttemptContext {
  runId: string
  params: EvalRunParams
  allowNetwork: (url: string) => boolean
  limits: Record<string, number>
  defaultModel: string | null
  opts: EvalRunnerOptions
  /** The run's own stop (cancel / drain): aborts the attempt like the wall cap. */
  signal?: AbortSignal
}

/** The goal the outcome judge reads for a rubric case: the case prompt + its success criteria. */
export function rubricGoal(c: Pick<EvalCaseRow, 'prompt' | 'rubric'>): string {
  return `Request: ${c.prompt}\n\nSuccess criteria: ${c.rubric ?? ''}`
}

export async function runAttempt(c: EvalCaseRow, attempt: number, x: AttemptContext): Promise<AttemptRecord> {
  const started = Date.now()
  const wallMs = x.opts.wallMs ?? ATTEMPT_WALL_MS
  const ac = new AbortController()
  let wallHit = false
  const wall = setTimeout(() => { wallHit = true; ac.abort() }, wallMs)
  const onStop = () => ac.abort()
  x.signal?.addEventListener('abort', onStop, { once: true })
  let world: EvalWorld | null = null
  let failed: string | null = null
  let toolLog: EvalToolLogEntry[] = []
  let finalText = ''
  let tokens = 0
  let judge: EvalAttemptOutcome['judge'] = null
  let captured: CapturedWrite[] = []
  let taint: { tainted: boolean; sources: string[] } = { tainted: false, sources: [] }
  let workstream: EvalWorkstreamOutcome | null = null
  const stuck: string[] = []
  const pool = x.opts.pool ?? evalPool
  try {
    world = await installEvalWorld(x.runId, c.setup, { allowNetwork: x.allowNetwork, throttle: evalThrottle(pool) })
    const w = world
    const runFn = (r: AgentRun) => runTurn(r, x.opts.runner ?? {})
    let root: Root | null = null
    try {
      // Final fix wave (M1): drift BEFORE the attempt too — a public table this world does not shadow
      // (a migration landed since it was built) would take an in-world write straight to Tony's table;
      // the post-attempt check below only reports it after the fact. Nothing runs in a drifted world.
      if (x.opts.afterInstall) await x.opts.afterInstall(w)
      const before = await w.drift()
      if (before.length) throw new TenantDriftError(before)
      root = await w.run(() => startCase(c, w.setup, { model: x.params.model ?? null, writeFiles: x.opts.writeFiles ?? sandboxWriteFiles }))
      const r = root
      await w.run(() => driveAttempt(r, {
        signal: ac.signal, runFn, limits: x.limits,
        defaultModel: x.defaultModel, model: x.params.model ?? null, pollMs: x.opts.pollMs ?? 250,
        unwindMs: x.opts.unwindMs ?? UNWIND_MS, stuck, pool
      }))
    } catch (err) {
      failed = err instanceof AttemptStopped
        ? (wallHit ? `wall cap: the attempt ran past ${Math.round(wallMs / 1000)} s` : 'stopped: the run was cancelled or the worker is draining')
        : err instanceof TenantDriftError ? err.message
          : `error: ${oneLine((err as Error).message ?? String(err), 300)}`
    }
    clearTimeout(wall)
    if (stuck.length) failed = `${failed ? `${failed}; ` : ''}${stuck.length} run(s) ignored the abort — their eval slots were force-released`
    // Carry (Task 2): settle → fail on truncation / drift → score → dispose.
    await w.settle()
    if (w.truncated) failed ??= 'the capture log was truncated (a forbidden write may be unrecorded)'
    const drift = await w.drift()
    if (drift.length) failed ??= `tenant drift: public has tables this world does not shadow (${drift.slice(0, 5).join(', ')})`
    captured = [...w.captured]
    toolLog = await w.run(() => readToolLog(w.schema))
    tokens = await w.run(() => worldTokens()).catch(() => 0)
    if (root) {
      const r = root
      finalText = await w.run(() => finalTextOf(r))
      workstream = await w.run(() => workstreamOutcome(r)).catch(() => null)
      if (c.expectTainted) taint = await w.run(() => worldTaint(r))
      if (c.rubric && !failed) {
        const evidence = await w.run(() => buildOutcomeEvidence({ goal: rubricGoal(c), summary: finalText || '(no final answer)', conversationId: r.conversationId, workspaceId: r.workspaceId, ns: w.schema }))
        const v = await w.run(() => (x.opts.verify ?? verifyOutcome)(evidence))
        judge = { verdict: v.verdict, confidence: v.confidence, gaps: v.gaps, nextStep: v.nextStep, model: v.model, latencyMs: v.latencyMs, ...(v.error ? { error: v.error } : {}) }
      }
    }
  } catch (err) {
    failed ??= `error: ${oneLine((err as Error).message ?? String(err), 300)}`
  } finally {
    clearTimeout(wall)
    x.signal?.removeEventListener('abort', onStop)
    if (world) await world.dispose().catch(err => console.warn(`[eval] disposing a world of run ${x.runId} failed:`, (err as Error).message))
  }
  const calls: EvalToolCall[] = toolLog.map(e => ({ tool: e.tool, args: e.args, status: e.status }))
  const mode = (c.matchMode as MatchMode) ?? 'ordered_subset'
  const match = matchActions(c.expectedActions ?? [], calls, mode, { countFailed: c.countFailed })
  const forbidden = forbiddenHits(c.forbiddenActions ?? [], calls)
  const content = contentMatches(c.expectedContent ?? [], finalText)
  const approvals = captured.filter(w => w.kind === 'approval.request').map(w => ({ tool: String(w.detail.tool ?? '?'), approved: w.detail.approved === true }))
  const appr = approvalChecks(c.expectedApprovals ?? [], c.forbiddenApprovals ?? [], approvals)
  // S1: a REAL guard flag (not the fail-closed `unverified`) on a call an expected action matched — or,
  // when the case expects no actions, on any call.
  const matchedCalls = c.expectedActions?.length ? match.matched.map(m => toolLog[m.call]!) : toolLog
  const flaggedOk = c.expectFlagged ? matchedCalls.some(e => !!e?.flagged && !e.unverified) : null
  const taintedOk = c.expectTainted ? taint.tainted : null
  const checks: EvalAttemptScoring['checks'] = {
    flagged: flaggedOk, tainted: taintedOk, taintSources: taint.sources,
    approvalsMissing: appr.missing, forbiddenApprovals: appr.forbidden,
    pass: flaggedOk !== false && taintedOk !== false && appr.missing.length === 0
  }
  const forbiddenHit = forbidden.length > 0 || appr.forbidden.length > 0
  const outcomeMetV = c.rubric ? (judge ? outcomeMet({ verdict: judge.verdict, confidence: judge.confidence, error: judge.error }) : false) : null
  const score = scoreAttempt({ actionScore: match.score, contentPass: content.pass, checksPass: checks.pass, forbidden: forbiddenHit, outcomeMet: outcomeMetV, failed })
  const scoring: EvalAttemptScoring = {
    spec: scoringSpecOf(c),
    mode, actionScore: match.score, matched: match.matched, unmatched: match.unmatched, extra: match.extra,
    forbidden, content, outcomeMet: outcomeMetV, checks, failed
  }
  return {
    caseId: c.id, attempt, score, passed: !failed && !forbiddenHit && score >= CASE_PASS_MEAN, forbidden: forbiddenHit, failed,
    toolLog, finalText, outcome: { judge, scoring, approvals, ...(workstream ? { workstream } : {}) }, captured, durationMs: Date.now() - started, tokens
  }
}

// ── A whole run ──────────────────────────────────────────────────────────────────────────────

async function casesOf(run: EvalRunRow, params: EvalRunParams): Promise<EvalCaseRow[]> {
  const rows = await useDb().select().from(evalCases).where(eq(evalCases.suiteId, run.suiteId)).orderBy(asc(evalCases.slug))
  if (params.cases?.length) {
    const want = new Set(params.cases)
    return rows.filter(r => want.has(r.slug))
  }
  return rows.filter(r => r.enabled)
}

async function patchRun(runId: string, set: Partial<typeof evalRuns.$inferInsert>, o: { onlyRunning?: boolean } = {}): Promise<boolean> {
  const rows = await useDb().update(evalRuns).set(set)
    .where(and(eq(evalRuns.id, runId), o.onlyRunning ? and(eq(evalRuns.status, 'running'), eq(evalRuns.owner, BOOT_ID)) : undefined))
    .returning({ id: evalRuns.id })
  if (rows.length) publishChange({ resource: 'eval', action: 'updated', id: runId })
  return rows.length > 0
}

/** The run's summary from its stored results (also used for a crashed run's partial results). */
export async function summarizeStored(runId: string, o: { durationMs: number; planned?: number; promptHashes?: Record<string, string> }): Promise<EvalRunSummary> {
  const rows = await useDb().select({
    caseId: evalResults.caseId, slug: evalCases.slug, holdout: evalCases.holdout, score: evalResults.score, outcome: evalResults.outcome,
    error: evalResults.error, tokens: evalResults.tokens, durationMs: evalResults.durationMs
  }).from(evalResults).innerJoin(evalCases, eq(evalCases.id, evalResults.caseId))
    .where(eq(evalResults.runId, runId)).orderBy(asc(evalCases.slug), asc(evalResults.attempt))
  const byCase = new Map<string, CaseForSummary>()
  for (const r of rows) {
    let c = byCase.get(r.caseId)
    if (!c) byCase.set(r.caseId, c = { caseId: r.caseId, slug: r.slug, holdout: r.holdout, attempts: [] })
    const scoring = (r.outcome as EvalAttemptOutcome | null)?.scoring
    c.attempts.push({ score: r.score ?? 0, forbidden: attemptHitForbidden(scoring), failed: !!r.error, tokens: r.tokens ?? 0, durationMs: r.durationMs ?? 0 })
  }
  return { ...summarizeRun([...byCase.values()], { durationMs: o.durationMs }), ...(o.planned !== undefined ? { planned: o.planned } : {}), ...(o.promptHashes ? { promptHashes: o.promptHashes } : {}) }
}

async function writeResult(runId: string, r: AttemptRecord): Promise<void> {
  await useDb().insert(evalResults).values({
    runId, caseId: r.caseId, attempt: r.attempt, score: r.score, passed: r.passed,
    toolLog: r.toolLog, finalText: r.finalText, outcome: r.outcome as unknown as Record<string, unknown>,
    capturedWrites: r.captured, error: r.failed, durationMs: r.durationMs, tokens: r.tokens
  })
  // Fix round 1 (Task 4): the RUN's id — what changed for any page is the run (its results list);
  // the dashboard scopes refetches by the ids it shows, and a brand-new result is shown by no page yet.
  publishChange({ resource: 'eval', action: 'created', id: runId })
}

/** Final fix wave (M1): the eval runs executing in this process → their immediate stop. */
const activeStops = new Map<string, () => void>()

/** Stops these runs NOW if this process executes them (their attempts abort and unwind, their worlds are
 *  dropped) — for runs already marked cancelled; the heartbeat would notice within EVAL_RUN_BEAT_MS.
 *  Returns the ids it stopped. */
export function stopEvalRunsNow(runIds: string[]): string[] {
  const out: string[] = []
  for (const id of runIds) {
    const stop = activeStops.get(id)
    if (stop) { stop(); out.push(id) }
  }
  return out
}

/**
 * Executes one CLAIMED eval run (status 'running', owner this boot — runs.ts claimEvalRun) to the end.
 * Never throws: any failure ends the run `failed` with its error and the results written so far.
 * Always cleans up its worlds (cleanupEvalRun) before it returns.
 */
export async function executeEvalRun(runId: string, opts: EvalRunnerOptions = {}): Promise<EvalRunRow | null> {
  const started = Date.now()
  const stop = new AbortController()
  let cancelled = false
  const beat = setInterval(() => {
    void (async () => {
      if (claimingIsStopped()) stop.abort()
      const rows = await useDb().update(evalRuns).set({ aliveAt: new Date() })
        .where(and(eq(evalRuns.id, runId), eq(evalRuns.status, 'running'), eq(evalRuns.owner, BOOT_ID))).returning({ id: evalRuns.id })
      if (!rows.length) { cancelled = true; stop.abort() }
    })().catch(err => console.warn('[eval] heartbeat failed:', (err as Error).message))
  }, opts.beatMs ?? EVAL_RUN_BEAT_MS)
  let planned = 0
  let promptHashes: Record<string, string> = {}
  let overBudget: string | null = null
  activeStops.set(runId, () => { cancelled = true; stop.abort() })
  try {
    const [run] = await useDb().select().from(evalRuns).where(eq(evalRuns.id, runId))
    if (!run || run.status !== 'running' || run.owner !== BOOT_ID) return run ?? null
    const params = (run.params ?? {}) as EvalRunParams
    const cases = await casesOf(run, params)
    if (!cases.length) throw new Error(params.cases?.length ? `no case of the suite matches ${params.cases.join(', ')}` : 'the suite has no enabled case')
    const doc = await loadConfig()
    const head = primaryModelFrom(doc, params.model)
    const limits = await (opts.poolLimits ?? poolLimits)()
    // Fix round 1 (M7): a prompt that cannot be built fails the run start — a placeholder would read
    // as a stable hash across runs.
    for (const c of cases) {
      try { promptHashes[c.slug] = await (opts.promptHash ?? casePromptHash)(c) } catch (err) { throw new Error(`building the system prompt of case ${c.slug} failed: ${(err as Error).message}`) }
    }
    await patchRun(runId, {
      gitSha: await gitSha(), modelLabel: await modelLabel(params.model), toolsHash: await toolsHash(), promptHash: runPromptHash(promptHashes)
    }, { onlyRunning: true })
    const allowNetwork = opts.allowNetwork ?? gatewayAllow(gatewayOriginsFrom(doc, params.model))
    const queue = cases.flatMap(c => Array.from({ length: Math.max(1, params.n ?? c.nRuns) }, (_, i) => ({ c, attempt: i + 1 })))
    planned = queue.length
    await patchRun(runId, { summary: await summarizeStored(runId, { durationMs: 0, planned, promptHashes }) as unknown as Record<string, unknown> }, { onlyRunning: true })
    const defaultModel = head?.modelDefId ?? null
    // Final fix wave (I2/I3): attempts in parallel come from settings `eval.concurrency` (1 on prod),
    // never above EVAL_MAX_CONCURRENCY, and each attempt's model calls stay inside the model's one eval
    // budget (pool.ts) whatever this is. The worlds must fit beside Tony's Postgres connections.
    const knobs = await readEvalSettingsFresh()
    const concurrency = Math.min(EVAL_MAX_CONCURRENCY, queue.length, Math.max(1, opts.concurrency ?? knobs.concurrency))
    const budget = opts.maxTokensPerRun ?? knobs.maxTokensPerRun
    await assertEvalConnectionsFit(concurrency, opts.connectionStats)
    const ctx: AttemptContext = { runId, params, allowNetwork, limits, defaultModel, opts, signal: stop.signal }
    let next = 0
    let spent = 0
    const write = opts.writeResult ?? writeResult
    const worker = async () => {
      while (next < queue.length && !stop.signal.aborted && !claimingIsStopped()) {
        const { c, attempt } = queue[next++]!
        const rec = await runAttempt(c, attempt, ctx)
        // A stop mid-attempt records nothing for it (it never finished); every finished attempt is kept.
        if (stop.signal.aborted && rec.failed?.startsWith('stopped')) return
        await write(runId, rec)
        await patchRun(runId, { summary: await summarizeStored(runId, { durationMs: Date.now() - started, planned, promptHashes }) as unknown as Record<string, unknown> }, { onlyRunning: true })
        // I4: past the token budget the run stops — attempts in flight are aborted (not recorded),
        // nothing new starts; the results so far are kept.
        spent += rec.tokens || 0
        if (spent > budget && !overBudget) {
          overBudget = `${BUDGET_STOP_PREFIX} — the attempts used ${spent.toLocaleString('en-US')} tokens, over the run's ${budget.toLocaleString('en-US')} (eval.maxTokensPerRun); partial results kept`
          stop.abort()
        }
      }
    }
    // Fix round 1 (I1): one worker failing stops the others FIRST (abort: their attempts end, nothing
    // new starts), and every worker has settled before the run is marked failed and cleaned up — no
    // sibling may install a world or write a result after the cleanup.
    let firstError: unknown = null
    await Promise.allSettled(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker().catch((err) => {
      firstError ??= err
      stop.abort()
    })))
    if (firstError) throw firstError
    if (claimingIsStopped()) stop.abort()
    const summary = await summarizeStored(runId, { durationMs: Date.now() - started, planned, promptHashes }) as unknown as Record<string, unknown>
    if (cancelled) await patchRun(runId, { summary, finishedAt: new Date() })
    else if (overBudget) await patchRun(runId, { status: 'failed', error: overBudget, summary, finishedAt: new Date() }, { onlyRunning: true })
    else if (stop.signal.aborted) await patchRun(runId, { status: 'failed', error: 'the worker stopped mid-run (drain) — partial results kept', summary, finishedAt: new Date() }, { onlyRunning: true })
    else await patchRun(runId, { status: 'done', summary, finishedAt: new Date() }, { onlyRunning: true })
  } catch (err) {
    console.error(`[eval] run ${runId} failed:`, err)
    const summary = await summarizeStored(runId, { durationMs: Date.now() - started, planned, promptHashes }).catch(() => null)
    await patchRun(runId, { status: 'failed', error: oneLine((err as Error).message ?? String(err), 500), finishedAt: new Date(), ...(summary ? { summary: summary as unknown as Record<string, unknown> } : {}) }, { onlyRunning: true }).catch(() => {})
  } finally {
    clearInterval(beat)
    activeStops.delete(runId)
    await cleanupEvalRun(runId).catch(err => console.warn(`[eval] cleanup of run ${runId} failed:`, (err as Error).message))
  }
  const [row] = await useDb().select().from(evalRuns).where(eq(evalRuns.id, runId))
  if (row) await recordEvalRunActivity(row, Date.now() - started).catch(err => console.warn(`[eval] recording run ${runId}'s activity row failed:`, (err as Error).message))
  return row ?? null
}

/**
 * Final fix wave (M5): ONE activity_log row per finished eval run, written OUTSIDE any world — the
 * in-world model calls never reach activity_log (isolation), so without it a run's tokens would be
 * invisible to Tony's usage/cost views. A summary only: tokens, duration, pass rate, model, status —
 * never case content (no prompts, answers or tool arguments).
 */
export async function recordEvalRunActivity(run: EvalRunRow, durationMs: number): Promise<void> {
  const { captureEnabled, recordEvent } = await import('../observability/record')
  if (!(await captureEnabled('eval'))) return
  const s = (run.summary ?? null) as EvalRunSummary | null
  const ok = run.status === 'done'
  recordEvent({
    kind: 'eval', name: 'eval:run',
    status: ok ? 'ok' : 'warn', severity: ok ? 'info' : 'warn',
    durationMs: s?.durationMs ?? durationMs, tokens: { total: s?.tokens ?? 0 },
    modelId: run.modelLabel ?? null,
    meta: {
      runId: run.id, suiteId: run.suiteId, status: run.status,
      attempts: s?.attempts ?? 0, failedAttempts: s?.failedAttempts ?? 0,
      passRate: s?.overall.passRate ?? null, nonHoldoutPassRate: s?.nonHoldout.passRate ?? null, meanScore: s?.overall.meanScore ?? null,
      ...(run.error ? { stopped: run.error.slice(0, 120) } : {})
    }
  })
}
