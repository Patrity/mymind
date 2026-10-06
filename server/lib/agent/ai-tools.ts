// server/lib/agent/ai-tools.ts
import { randomUUID } from 'node:crypto'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { AgentTool, ToolContext, ApprovalRequest, ToolStartEvent, ToolResultEvent, SubagentEvent } from './types'
import { publishActivity } from './bus'
import { registerUndo } from './undo'
import { withSpan } from '../observability/record'
import type { ToolsetId } from './toolsets'

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
}

async function approvalRequestFor(t: AgentTool, input: Record<string, unknown>, approvalNonce: string): Promise<ApprovalRequest> {
  const req = t.describeApproval
    ? await t.describeApproval(input, { approvalNonce })
    : { tool: t.name, command: JSON.stringify(input), proposedPattern: `${t.name} *` }
  // From the tool definition, overriding anything describeApproval returned.
  return { ...req, allowlistable: t.allowlistable === true }
}

/** The card heading for an egress call in a tainted run (fix wave I3). */
export const EGRESS_APPROVAL_TITLE = 'Web request after reading your mail'

/** An egress tool's approval card: the exact URL / query / brief that would leave the box, one
 *  `key: value` line per arg, never truncated (the web card scrolls; iMessage states its cut).
 *  `logSummary` is body-free — the args may be exactly the exfiltrated content. */
function egressApprovalRequest(t: AgentTool, input: Record<string, unknown>): ApprovalRequest {
  const lines = Object.entries(input)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  const chars = lines.reduce((n, l) => n + l.length, 0)
  return {
    tool: t.name,
    title: EGRESS_APPROVAL_TITLE,
    command: [
      `${t.name} — Bridget read your Google mail, calendar or contacts earlier in this run, and this request sends the text below to the internet. Approve only if you expected it.`,
      '',
      ...lines
    ].join('\n'),
    proposedPattern: '',
    allowlistable: false,
    logSummary: `${t.name}: egress after a Google read (${chars} arg chars)`
  }
}

/** A `taints` call that produced data (not an `{ error }` result) has put Google content in the
 *  model's context. */
function producedContent(result: unknown): boolean {
  return !(result && typeof result === 'object' && 'error' in result)
}

/** Adapt the agent tool registry into an AI SDK ToolSet (execute = gate + handler + bus + undo). */
export function buildAiTools(registry: AgentTool[], hooks: RunHooks): ToolSet {
  // Run-level taint (cycle 79 fix wave I3): one ToolSet is built per run, so this flag lives
  // exactly as long as the run. It flips the first time a `taints` tool (gmail_search,
  // gmail_read_thread, contacts_search, calendar_list_events) returns content, and NEVER resets
  // within the run: from then on every `egress` tool (web_fetch, web_search, research_web) is
  // gated like a dangerous tool — not allowlistable, and auto-denied where there's no approval
  // channel (headless). Before any Google read, egress runs freely as always.
  let tainted = false
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
        // autoApprove fast-path clears it (allowlist-first). An egress tool in a tainted run
        // (fix wave I3) is gated the same way, but never auto-approved and never allowlistable.
        const egressGated = t.egress === true && tainted
        if (t.dangerous || egressGated) {
          const auto = !egressGated && t.autoApprove ? await t.autoApprove(input, callCtx) : false
          if (!auto) {
            const req = egressGated ? egressApprovalRequest(t, input) : await approvalRequestFor(t, input, approvalNonce)
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
