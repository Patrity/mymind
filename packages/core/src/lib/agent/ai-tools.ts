// server/lib/agent/ai-tools.ts
import { randomUUID } from 'node:crypto'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { AgentTool, ToolContext, ApprovalRequest, RequestApproval, ToolStartEvent, ToolResultEvent, SubagentEvent } from './types'
import { createApprovalJudge, type ApprovalJudge } from './judge/approval'
import type { ApprovalSurface } from './judge/types'
import type { JudgeMessage } from './judge/verdict'
import { publishActivity } from './bus'
import { registerUndo } from './undo'
import { recordEvent, withSpan } from '../observability/record'
import type { ToolsetId } from './toolsets'
import { carriesInjectionWarning, carriesWorkspaceTaint, childTaintOf, producedContent } from './tool-history'
import { guardOutput, guardReasons, guardWarning, outputWarningDTO, wrapFlagged, type GuardInput, type GuardVerdict } from './judge/guard'
import { RUN_CALL_ARGS_CHARS, TAINT_SOURCES, type OutputWarningDTO, type RunCall, type RunTaint, type TaintFlag, type TaintSource } from './judge/types'
import { cutAt } from './judge/verdict'

export interface RunHooks {
  signal: AbortSignal
  requestApproval?: RequestApproval
  attachmentImageIds?: string[]
  runId?: string
  onEvent: (e: ToolStartEvent | ToolResultEvent | SubagentEvent) => void
  /** Cycle 78: fires first thing on every call — run.ts auto-loads the tool's toolset. */
  onToolCalled?: (name: string) => void
  /** Cycle 78: handed to tools as ctx.loadToolsets (load_toolsets uses it). */
  loadToolsets?: (ids: ToolsetId[]) => ToolsetId[]
  /** Cycle 79b (a): the run starts tainted — run.ts sets this when the model-visible history
   *  still carries a `taints` tool's content from an earlier turn. */
  initiallyTainted?: boolean
  /** Task 4 fix round 0 (C1/C2): the same seed with its reasons (run.ts historyTaint) — wins over
   *  `initiallyTainted`. A bare `initiallyTainted: true` reads as a mail taint (its 79b meaning). */
  initialTaint?: RunTaint
  /** Cycle 84 Task 2: judge every approval request of this run (judge/approval.ts) — where it was
   *  raised and the context the judge reads. Absent: no judge (MCP, legacy callers). */
  judge?: { surface: ApprovalSurface; workstreamId?: string; goal?: string | null; recentMessages?: JudgeMessage[] }
  /** Cycle 84 Task 3: the output guard (tests inject one). Default: judge/guard.ts guardOutput. */
  guard?: (input: GuardInput) => Promise<GuardVerdict>
  /** Cycle 84 Task 3: taint the run's workspace after a flagged workspace result (tests inject one).
   *  Default: sandbox/runtime.ts taintRunWorkspace. */
  taintWorkspace?: (runId: string | undefined) => Promise<void>
  /** Final fix wave (M5): this run is a subagent's own (research_web) — its guarded results are
   *  checked by heuristics only; the parent classifies the subagent's report once. */
  nestedGuard?: boolean
  /** Cycle 84 final fix wave (C1): the run gained a taint source (also fired once at the start when
   *  it begins tainted) — the runner persists it on the workstream at once. Errors are swallowed. */
  onTaint?: (t: RunTaint) => void
}

async function approvalRequestFor(t: AgentTool, input: Record<string, unknown>, approvalNonce: string): Promise<ApprovalRequest> {
  const req = t.describeApproval
    ? await t.describeApproval(input, { approvalNonce })
    : { tool: t.name, command: JSON.stringify(input), proposedPattern: `${t.name} *` }
  // From the tool definition, overriding anything describeApproval returned.
  return { ...req, allowlistable: t.allowlistable === true }
}

/** Card headings for an `outbound` call in a tainted run (fix wave I3; 79b adds background work). */
export const OUTBOUND_WEB_TITLE = 'Web request after reading your mail'
export const OUTBOUND_BACKGROUND_TITLE = 'Background work after reading your mail'
/** 79b fix round 1 (I2): an allowlistable dangerous tool (exec) in a tainted run. */
export const TAINTED_COMMAND_TITLE = 'Command after reading your mail'

/**
 * Task 4 fix round 0 (C1): the heading and the lead clause follow WHY the run is tainted. The card
 * is titled by the most specific source (flagged content, then a mail read, then a tainted
 * workspace); the lead names every source. Mail-only keeps the 79b wording exactly.
 */
export const TAINT_TITLES: Record<TaintSource, { web: string; background: string; command: string; clause: string }> = {
  flagged: {
    web: 'Web request after flagged content',
    background: 'Background work after flagged content',
    command: 'Command after flagged content',
    clause: 'Bridget read content the injection guard flagged as instructions aimed at her'
  },
  mail: {
    web: OUTBOUND_WEB_TITLE,
    background: OUTBOUND_BACKGROUND_TITLE,
    command: TAINTED_COMMAND_TITLE,
    clause: 'Bridget read your Google mail, calendar or contacts recently'
  },
  child: {
    web: 'Web request after reading a tainted child\'s output',
    background: 'Background work after reading a tainted child\'s output',
    command: 'Command after reading a tainted child\'s output',
    clause: 'Bridget read output from a child workstream that handled untrusted content'
  },
  workspace: {
    web: 'Web request from a tainted workspace',
    background: 'Background work from a tainted workspace',
    command: 'Command from a tainted workspace',
    clause: 'Bridget used a workspace that has handled untrusted content'
  },
  unverified: {
    web: 'Web request after unchecked content',
    background: 'Background work after unchecked content',
    command: 'Command after unchecked content',
    clause: 'Bridget read content the injection check could not verify (it timed out or was unavailable)'
  }
}

/** The titles for a tainted run's card. Sources in any order; none → the mail wording (fail safe). */
export function taintTitles(sources: readonly TaintSource[]): { web: string; background: string; command: string; lead: string } {
  const ordered = TAINT_SOURCES.filter(x => sources.includes(x))
  const list = ordered.length ? ordered : (['mail'] as TaintSource[])
  const head = TAINT_TITLES[list[0]!]
  return { web: head.web, background: head.background, command: head.command, lead: list.map(x => TAINT_TITLES[x].clause).join('; ') }
}

/** An outbound tool's approval card: exactly what would leave Tony's sight — the URL / query /
 *  brief, or the job markdown / wake time + reason — one `key: value` line per arg, never
 *  truncated (the web card scrolls; iMessage states its cut). Non-read outbound tools (jobs,
 *  wakes, skills) get the background-work wording; web reads the web wording. `logSummary` is body-free —
 *  the args may be exactly the exfiltrated content. */
async function outboundApprovalRequest(t: AgentTool, input: Record<string, unknown>, sources: readonly TaintSource[]): Promise<ApprovalRequest> {
  // Web tools are reads that leave the box; every other outbound tool (jobs, wakes, skills)
  // writes something a later, unwatched run acts on.
  const background = t.kind !== 'read'
  const titles = taintTitles(sources)
  const lines = Object.entries(input)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  let detail: string | undefined
  if (t.outboundDetail) {
    try { detail = await t.outboundDetail(input) } catch { detail = undefined }
  }
  const chars = lines.reduce((n, l) => n + l.length, 0) + (detail?.length ?? 0)
  const lead = background
    ? `${t.name} — ${titles.lead}, and this sets up work that runs later without you watching (it can carry what she read). Approve only if you expected it.`
    : `${t.name} — ${titles.lead}, and this request sends the text below to the internet. Approve only if you expected it.`
  const why = TAINT_SOURCES.filter(x => sources.includes(x))
  return {
    tool: t.name,
    title: background ? titles.background : titles.web,
    command: [lead, '', ...lines, ...(detail ? ['', detail] : [])].join('\n'),
    proposedPattern: '',
    allowlistable: false,
    logSummary: why.length === 1 && why[0] === 'mail'
      ? `${t.name}: outbound after a Google read (${chars} chars)`
      : `${t.name}: outbound in a tainted run (${(why.length ? why : ['mail']).join('+')}; ${chars} chars)`
  }
}

/** I2: a call's masked args in at most RUN_CALL_ARGS_CHARS chars (the judge's run trail). */
export function argSummary(args: Record<string, unknown>): string {
  let json: string
  try { json = JSON.stringify(args) ?? '' } catch { json = '[unserializable]' }
  const one = json.replace(/\s+/g, ' ')
  return one.length > RUN_CALL_ARGS_CHARS ? `${cutAt(one, RUN_CALL_ARGS_CHARS - 1)}…` : one
}

/** Final fix wave (I5): a guard flag that may persist taint beyond the run (a workspace, a delivered
 *  watch result) — a real verdict only, never a fail-closed one. */
export function workspaceTaintingVerdict(v: Pick<GuardVerdict, 'flagged' | 'by'>): boolean {
  return v.flagged && (v.by === 'heuristics' || v.by === 'llm')
}

/** Adapt the agent tool registry into an AI SDK ToolSet (execute = gate + handler + bus + undo). */
export function buildAiTools(registry: AgentTool[], hooks: RunHooks): ToolSet {
  // Run-level taint (cycle 79 fix wave I3, 79b): one ToolSet is built per run, so this flag lives
  // exactly as long as the run. It starts true when the model-visible history still carries a
  // `taints` tool's content (79b cross-turn seed, computed by run.ts), flips the first time a
  // `taints` tool returns content in this run, and NEVER resets within the run: from then on every
  // `outbound` tool (web_fetch, web_search, research_web, create_job, edit_job, run_job,
  // schedule_wake) is gated like a dangerous tool — not allowlistable, and auto-denied where
  // there's no approval channel (headless). Untainted, outbound tools run freely as always.
  // Task 4 fix round 0 (C1/C2): the taint keeps its reasons — which sources, and the guard flags
  // behind a `flagged` source — for the card heading and the judge. Tainted ⇔ any source.
  const taintSources = new Set<TaintSource>(hooks.initialTaint ? hooks.initialTaint.sources : hooks.initiallyTainted === true ? ['mail'] : [])
  const taintFlags: TaintFlag[] = (hooks.initialTaint?.flags ?? []).map(f => ({ ...f, reasons: [...f.reasons] }))
  const isTainted = () => taintSources.size > 0
  const runTaint = (): RunTaint => ({ sources: TAINT_SOURCES.filter(x => taintSources.has(x)), flags: taintFlags.map(f => ({ ...f, reasons: [...f.reasons] })) })
  // C1: every new source is reported at once (a workstream persists it — sticky across segments).
  const notifyTaint = () => {
    if (!hooks.onTaint || !taintSources.size) return
    try { hooks.onTaint(runTaint()) } catch (err) { console.warn('[ai-tools] onTaint failed:', (err as Error).message) }
  }
  const addTaint = (x: TaintSource) => {
    if (taintSources.has(x)) return
    taintSources.add(x)
    notifyTaint()
  }
  notifyTaint()
  // I2 (final fix wave): this run's calls so far, as the judge reads them — tool, a short body-free
  // arg summary, the guard source and whether the guard flagged the result. Never results.
  const trail: RunCall[] = []
  const ctx: ToolContext = { signal: hooks.signal, requestApproval: hooks.requestApproval, attachmentImageIds: hooks.attachmentImageIds, runId: hooks.runId, loadToolsets: hooks.loadToolsets, isTainted, taint: runTaint }
  const guard = hooks.guard ?? guardOutput
  // Imported at call time: the sandbox runtime reaches back into the agent loop (watch wakes).
  const taintWorkspace = hooks.taintWorkspace ?? (async (runId: string | undefined) => (await import('../sandbox/runtime')).taintRunWorkspace(runId))

  /**
   * Cycle 84 Task 3 (spec §3.3): scan a `guard` tool's result. Unflagged → null (the result is
   * unchanged and nothing is tainted — an ordinary web read never taints). Flagged → the result
   * wrapped with the model-visible warning (still carrying its own untrusted note), the run tainted
   * (outbound gated), the workspace tainted for a
   * workspace result, the `judge:output-warning` activity (no content) and the chip's DTO.
   */
  async function guardResult(t: AgentTool, raw: unknown, callId: string, nestedFlagged: boolean): Promise<{ result: unknown; warning: OutputWarningDTO } | null> {
    // A denial or a headless proposal carries no tool content.
    if (raw && typeof raw === 'object' && ((raw as Record<string, unknown>).denied === true || (raw as Record<string, unknown>).proposed === true)) return null
    let v: GuardVerdict
    try {
      v = await guard({ tool: t.name, source: t.guard!, result: raw, signal: hooks.signal, ...(hooks.nestedGuard ? { nested: true } : {}) })
    } catch (err) {
      // guardOutput never throws; an injected guard might. The tool's own result still stands.
      console.warn(`[guard] scanning ${t.name} failed:`, (err as Error).message)
      if (!nestedFlagged) return null
      v = { flagged: false, by: null, score: 0, labels: [], suspicious: false, textChars: 0, latencyMs: 0 }
    }
    if (!v.flagged && nestedFlagged) v = { ...v, flagged: true, by: 'nested' }
    if (!v.flagged) return null
    // Final follow-up (N2): only a REAL verdict (flag-alone heuristic, classifier, a flagged nested
    // source) is `flagged` — persisted on a workstream for life. A fail-closed flag (the check could not
    // run) is `unverified`: this run only, never persisted or inherited.
    addTaint(v.by === 'fail-closed' ? 'unverified' : 'flagged')
    // Final fix wave (I5): only a REAL verdict — a flag-alone heuristic signal or the classifier saying
    // injection — marks the workspace tainted (persistent; its results then taint their readers). A
    // fail-closed flag (the classifier timed out, waited too long for a slot, errored, was off, or Stop
    // cancelled it) decided nothing about the content: the RUN is still tainted and warned.
    if (t.guard === 'workspace' && workspaceTaintingVerdict(v)) {
      // The run is tainted already, so its next workspace command would taint the workspace anyway;
      // this does it now.
      // M6: a failure is never silent — an activity error (the run itself stays tainted: fail closed).
      try { await taintWorkspace(hooks.runId) } catch (err) {
        console.warn(`[guard] tainting the workspace of run ${hooks.runId ?? '-'} failed:`, (err as Error).message)
        recordEvent({ kind: 'tool', name: 'judge:workspace-taint-failed', severity: 'error', meta: { tool: t.name, runId: hooks.runId ?? null, error: (err as Error).message.slice(0, 300) } })
      }
    }
    const warning = outputWarningDTO(callId, t.guard!, v)
    taintFlags.push({ tool: t.name, source: t.guard!, reasons: [...warning.reasons] })
    recordEvent({
      kind: 'tool', name: 'judge:output-warning', severity: 'warn',
      meta: {
        tool: t.name, source: t.guard, runId: hooks.runId ?? null, by: v.by, score: v.score, labels: v.labels,
        ...(v.llm ? { llm: { confidence: v.llm.confidence, model: v.llm.model, latencyMs: v.llm.latencyMs, ...(v.llm.error ? { error: v.llm.error } : {}) } } : {}),
        ...(v.llmSkipped ? { llmSkipped: v.llmSkipped } : {}),
        latencyMs: v.latencyMs
      }
    })
    return { result: wrapFlagged(raw, guardWarning(guardReasons(v))), warning }
  }

  const set: ToolSet = {}
  for (const t of registry) {
    set[t.name] = tool({
      description: t.description,
      inputSchema: z.object(t.schema),
      execute: async (input: Record<string, unknown>, opts?: { toolCallId?: string }) => {
        // FIRST, before redaction/approval: the call happened, so its toolset becomes visible
        // even if the call is then denied — the model evidently wants that set.
        hooks.onToolCalled?.(t.name)
        const callId = opts?.toolCallId ?? ''
        // A fresh, server-minted id for THIS execution — unlike `callId` above (the SDK's own
        // toolCallId, kept for UI correlation only), this is never empty and never reused: some
        // openai-compatible backends emit `id: ""` or a deterministic id like `call_0` per turn,
        // which would collapse two different approval requests onto one key (cycle 79 review
        // round 3, N1). A tool that binds a side effect to ONE specific approval request
        // (gmail_send's TOCTOU pin) must key on THIS, never on `callId`.
        const approvalNonce = randomUUID()
        // Per-call context: a subagent's nested calls are keyed to THIS call's SDK id, which
        // only exists here — the shared `ctx` above is built once for the whole toolset.
        // A subagent's nested result the guard flagged (research_web reading an injected page) makes
        // this call's own result flagged too: the report was written from that page.
        let nestedFlagged = false
        const callCtx: ToolContext = {
          ...ctx,
          callId,
          approvalNonce,
          onNestedEvent: (e) => {
            if (e.type === 'tool-result' && carriesInjectionWarning(e.result)) nestedFlagged = true
            hooks.onEvent({ type: 'subagent-event', parentCallId: callId, event: e })
          }
        }
        // Mask ONCE, up front, and use the masked copy for every RECORDED/EMITTED args field
        // below. Those args are persisted to conversation_messages.tool_calls and shipped to
        // the browser via msgToDTO, so a tool whose input can carry literal secret values
        // (exec — see tools/exec.ts redactForLog) must never emit them raw. The handler still
        // receives the ORIGINAL `input`; only the copy we record is masked.
        // A THROWING redactForLog (e.g. secrets undecryptable) no longer fails the whole tool
        // — it degrades to a body-free marker and lets the handler run and report for itself.
        let safeArgs: Record<string, unknown> = input
        if (t.redactForLog) {
          try { safeArgs = await t.redactForLog(input) as Record<string, unknown> }
          catch { safeArgs = { redacted: true, reason: 'redaction failed' } }
        }
        hooks.onEvent({ type: 'tool-start', name: t.name, args: safeArgs, callId })
        // I2: what the run did BEFORE this call (the judge of this call reads it), then this call.
        const priorCalls = trail.map(c => ({ ...c }))
        const trailEntry: RunCall = { tool: t.name, args: argSummary(safeArgs), ...(t.guard ? { guard: t.guard } : {}) }
        trail.push(trailEntry)
        // Dangerous tools pause for human approval BEFORE the handler runs — unless the tool's
        // autoApprove fast-path clears it (allowlist-first). An outbound tool in a tainted run
        // (fix wave I3) is gated the same way, but never auto-approved and never allowlistable.
        const tainted = isTainted()
        const outboundGated = t.outbound === true && tainted
        // 79b fix round 1 (I2): exec's allowlist/LAN fast-path is skipped in a tainted run — an
        // allowlisted `curl`/`python3 *`/`git push *` is a network path too. Every exec then asks,
        // titled for it and NOT allowlistable (no "always allow" off an injected command);
        // headless has no channel → auto-deny.
        const taintedAllowlistable = tainted && t.dangerous === true && t.allowlistable === true
        let judge: ApprovalJudge | undefined
        if (t.dangerous || outboundGated) {
          const auto = !outboundGated && !taintedAllowlistable && t.autoApprove ? await t.autoApprove(input, callCtx) : false
          if (!auto) {
            const req = outboundGated
              ? await outboundApprovalRequest(t, input, runTaint().sources)
              : taintedAllowlistable
                ? { ...await approvalRequestFor(t, input, approvalNonce), title: taintTitles(runTaint().sources).command, allowlistable: false }
                : await approvalRequestFor(t, input, approvalNonce)
            // Cycle 84: the judge of THIS request rides with it (in-process only) — the channel
            // starts it after publishing the card, and it may approve the call itself (Smart Approvals).
            judge = hooks.judge && ctx.requestApproval
              ? createApprovalJudge({
                  tool: t, input, req, nonce: approvalNonce, surface: hooks.judge.surface, runId: hooks.runId,
                  workstreamId: hooks.judge.workstreamId, goal: hooks.judge.goal, recentMessages: hooks.judge.recentMessages,
                  isTainted, taint: runTaint, runCalls: priorCalls, signal: hooks.signal
                })
              : undefined
            const card: ApprovalRequest = { ...req, callId, args: safeArgs }
            const decision = ctx.requestApproval
              ? await (judge ? ctx.requestApproval(card, { judge }) : ctx.requestApproval(card))
              : { approved: false } // fail-safe: no channel → auto-deny
            // Fix round 2 (defence in depth): Stop always beats a late approval — whatever a channel
            // returned, a run already stopped never executes the call.
            if (decision.approved !== true || hooks.signal.aborted) {
              const summary = `denied: ${t.name}`
              const result = { denied: true }
              publishActivity({ type: 'tool', name: t.name, summary })
              hooks.onEvent({ type: 'tool-result', name: t.name, summary, callId, args: safeArgs, result, kind: t.kind })
              return result
            }
          }
        }
        try {
          const exec = await withSpan(
            { kind: 'tool', name: t.name, request: safeArgs },
            () => t.handler(input, callCtx)
          )
          // Cycle 82: a workspace that handled tainted content taints every run that reads from it
          // (its files may be mail-derived) — the result says so with `workspaceTainted`.
          if (t.taints && producedContent(exec.result)) addTaint('mail')
          if (carriesWorkspaceTaint(exec.result)) addTaint('workspace')
          // Final follow-up: a tainted child's persisted sources (mail / flagged) taint this run too.
          for (const x of childTaintOf(exec.result)) addTaint(x)
          // Cycle 84 Task 3: the output guard, BEFORE the model (or the history) sees the result.
          const guarded = t.guard ? await guardResult(t, exec.result, callId, nestedFlagged) : null
          if (guarded) trailEntry.flagged = true
          const result = guarded?.result ?? exec.result
          const undoToken = exec.undo ? registerUndo(exec.undo) : undefined
          publishActivity({ type: 'tool', name: t.name, summary: exec.summary, undoToken })
          // The thread's "⚖ auto-approved (0.94): reason" rides on the call's own record (never an
          // event row mid-turn — that would fork the thread).
          const approval = judge?.autoNote() ?? undefined
          const outputWarning = guarded?.warning
          hooks.onEvent({ type: 'tool-result', name: t.name, summary: exec.summary, undoToken, images: exec.display?.images, callId, args: safeArgs, result, kind: t.kind, ...(approval ? { approval } : {}), ...(outputWarning ? { outputWarning } : {}) })
          return result
        } catch (err) {
          const summary = `failed: ${t.name}`
          const result = { error: (err as Error).message }
          publishActivity({ type: 'tool', name: t.name, summary })
          const approval = judge?.autoNote() ?? undefined
          hooks.onEvent({ type: 'tool-result', name: t.name, summary, callId, args: safeArgs, result, kind: t.kind, ...(approval ? { approval } : {}) })
          return result
        }
      }
    })
  }
  return set
}
