// server/lib/agent/ai-tools.ts
import { randomUUID } from 'node:crypto'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { AgentTool, ToolContext, ApprovalRequest, ToolStartEvent, ToolResultEvent, SubagentEvent } from './types'
import { publishActivity } from './bus'
import { registerUndo } from './undo'
import { withSpan } from '../observability/record'
import type { ToolsetId } from './toolsets'
import { producedContent } from './tool-history'

export interface RunHooks {
  signal: AbortSignal
  requestApproval?: (req: ApprovalRequest) => Promise<{ approved: boolean }>
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

/** An outbound tool's approval card: exactly what would leave Tony's sight — the URL / query /
 *  brief, or the job markdown / wake time + reason — one `key: value` line per arg, never
 *  truncated (the web card scrolls; iMessage states its cut). Non-read outbound tools (jobs,
 *  wakes, skills) get the background-work wording; web reads the web wording. `logSummary` is body-free —
 *  the args may be exactly the exfiltrated content. */
async function outboundApprovalRequest(t: AgentTool, input: Record<string, unknown>): Promise<ApprovalRequest> {
  // Web tools are reads that leave the box; every other outbound tool (jobs, wakes, skills)
  // writes something a later, unwatched run acts on.
  const background = t.kind !== 'read'
  const lines = Object.entries(input)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  let detail: string | undefined
  if (t.outboundDetail) {
    try { detail = await t.outboundDetail(input) } catch { detail = undefined }
  }
  const chars = lines.reduce((n, l) => n + l.length, 0) + (detail?.length ?? 0)
  const lead = background
    ? `${t.name} — Bridget read your Google mail, calendar or contacts recently, and this sets up work that runs later without you watching (it can carry what she read). Approve only if you expected it.`
    : `${t.name} — Bridget read your Google mail, calendar or contacts recently, and this request sends the text below to the internet. Approve only if you expected it.`
  return {
    tool: t.name,
    title: background ? OUTBOUND_BACKGROUND_TITLE : OUTBOUND_WEB_TITLE,
    command: [lead, '', ...lines, ...(detail ? ['', detail] : [])].join('\n'),
    proposedPattern: '',
    allowlistable: false,
    logSummary: `${t.name}: outbound after a Google read (${chars} chars)`
  }
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
  let tainted = hooks.initiallyTainted === true
  const ctx: ToolContext = { signal: hooks.signal, requestApproval: hooks.requestApproval, attachmentImageIds: hooks.attachmentImageIds, runId: hooks.runId, loadToolsets: hooks.loadToolsets }
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
        const callCtx: ToolContext = {
          ...ctx,
          callId,
          approvalNonce,
          onNestedEvent: e => hooks.onEvent({ type: 'subagent-event', parentCallId: callId, event: e })
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
        // Dangerous tools pause for human approval BEFORE the handler runs — unless the tool's
        // autoApprove fast-path clears it (allowlist-first). An outbound tool in a tainted run
        // (fix wave I3) is gated the same way, but never auto-approved and never allowlistable.
        const outboundGated = t.outbound === true && tainted
        // 79b fix round 1 (I2): exec's allowlist/LAN fast-path is skipped in a tainted run — an
        // allowlisted `curl`/`python3 *`/`git push *` is a network path too. Every exec then asks,
        // titled for it and NOT allowlistable (no "always allow" off an injected command);
        // headless has no channel → auto-deny.
        const taintedAllowlistable = tainted && t.dangerous === true && t.allowlistable === true
        if (t.dangerous || outboundGated) {
          const auto = !outboundGated && !taintedAllowlistable && t.autoApprove ? await t.autoApprove(input, callCtx) : false
          if (!auto) {
            const req = outboundGated
              ? await outboundApprovalRequest(t, input)
              : taintedAllowlistable
                ? { ...await approvalRequestFor(t, input, approvalNonce), title: TAINTED_COMMAND_TITLE, allowlistable: false }
                : await approvalRequestFor(t, input, approvalNonce)
            const decision = ctx.requestApproval
              ? await ctx.requestApproval({ ...req, callId, args: safeArgs })
              : { approved: false } // fail-safe: no channel → auto-deny
            if (decision.approved !== true) {
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
          if (t.taints && producedContent(exec.result)) tainted = true
          const undoToken = exec.undo ? registerUndo(exec.undo) : undefined
          publishActivity({ type: 'tool', name: t.name, summary: exec.summary, undoToken })
          hooks.onEvent({ type: 'tool-result', name: t.name, summary: exec.summary, undoToken, images: exec.display?.images, callId, args: safeArgs, result: exec.result, kind: t.kind })
          return exec.result
        } catch (err) {
          const summary = `failed: ${t.name}`
          const result = { error: (err as Error).message }
          publishActivity({ type: 'tool', name: t.name, summary })
          hooks.onEvent({ type: 'tool-result', name: t.name, summary, callId, args: safeArgs, result, kind: t.kind })
          return result
        }
      }
    })
  }
  return set
}
