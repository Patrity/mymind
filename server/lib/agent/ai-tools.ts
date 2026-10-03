// server/lib/agent/ai-tools.ts
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

function approvalRequestFor(t: AgentTool, input: Record<string, unknown>): ApprovalRequest {
  const req = t.describeApproval
    ? t.describeApproval(input)
    : { tool: t.name, command: JSON.stringify(input), proposedPattern: `${t.name} *` }
  // From the tool definition, overriding anything describeApproval returned.
  return { ...req, allowlistable: t.allowlistable === true }
}

/** Adapt the agent tool registry into an AI SDK ToolSet (execute = gate + handler + bus + undo). */
export function buildAiTools(registry: AgentTool[], hooks: RunHooks): ToolSet {
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
        // Per-call context: a subagent's nested calls are keyed to THIS call's id, which
        // only exists here — the shared `ctx` above is built once for the whole toolset.
        const callCtx: ToolContext = {
          ...ctx,
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
        // autoApprove fast-path clears it (allowlist-first).
        if (t.dangerous) {
          const auto = t.autoApprove ? await t.autoApprove(input, callCtx) : false
          if (!auto) {
            const decision = ctx.requestApproval
              ? await ctx.requestApproval({ ...approvalRequestFor(t, input), callId, args: safeArgs })
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
