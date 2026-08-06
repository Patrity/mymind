// server/lib/agent/ai-tools.ts
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { AgentTool, ToolContext, ApprovalRequest, ToolKind } from './types'
import { publishActivity } from './bus'
import { registerUndo } from './undo'
import { withSpan } from '../observability/record'

export interface RunHooks {
  signal: AbortSignal
  requestApproval?: (req: ApprovalRequest) => Promise<{ approved: boolean }>
  attachmentImageIds?: string[]
  onEvent: (e:
    | { type: 'tool-start'; name: string; args: Record<string, unknown> }
    | { type: 'tool-result'; name: string; summary: string; undoToken?: string; images?: import('./image-embed').DisplayImage[]; callId?: string; args?: Record<string, unknown>; result?: unknown; kind?: ToolKind }) => void
}

function approvalRequestFor(t: AgentTool, input: Record<string, unknown>): ApprovalRequest {
  if (t.describeApproval) return t.describeApproval(input)
  return { tool: t.name, command: JSON.stringify(input), proposedPattern: `${t.name} *` }
}

/** Adapt the agent tool registry into an AI SDK ToolSet (execute = gate + handler + bus + undo). */
export function buildAiTools(registry: AgentTool[], hooks: RunHooks): ToolSet {
  const ctx: ToolContext = { signal: hooks.signal, requestApproval: hooks.requestApproval, attachmentImageIds: hooks.attachmentImageIds }
  const set: ToolSet = {}
  for (const t of registry) {
    set[t.name] = tool({
      description: t.description,
      inputSchema: z.object(t.schema),
      execute: async (input: Record<string, unknown>, opts?: { toolCallId?: string }) => {
        const callId = opts?.toolCallId ?? ''
        hooks.onEvent({ type: 'tool-start', name: t.name, args: input })
        // Dangerous tools pause for human approval BEFORE the handler runs — unless the tool's
        // autoApprove fast-path clears it (allowlist-first).
        if (t.dangerous) {
          const auto = t.autoApprove ? await t.autoApprove(input, ctx) : false
          if (!auto) {
            const decision = ctx.requestApproval
              ? await ctx.requestApproval(approvalRequestFor(t, input))
              : { approved: false } // fail-safe: no channel → auto-deny
            if (decision.approved !== true) {
              const summary = `denied: ${t.name}`
              const result = { denied: true }
              publishActivity({ type: 'tool', name: t.name, summary })
              hooks.onEvent({ type: 'tool-result', name: t.name, summary, callId, args: input, result, kind: t.kind })
              return result
            }
          }
        }
        try {
          const reqForLog = t.redactForLog ? await t.redactForLog(input) : input
          const exec = await withSpan(
            { kind: 'tool', name: t.name, request: reqForLog as Record<string, unknown> },
            () => t.handler(input, ctx)
          )
          const undoToken = exec.undo ? registerUndo(exec.undo) : undefined
          publishActivity({ type: 'tool', name: t.name, summary: exec.summary, undoToken })
          hooks.onEvent({ type: 'tool-result', name: t.name, summary: exec.summary, undoToken, images: exec.display?.images, callId, args: input, result: exec.result, kind: t.kind })
          return exec.result
        } catch (err) {
          const summary = `failed: ${t.name}`
          const result = { error: (err as Error).message }
          publishActivity({ type: 'tool', name: t.name, summary })
          hooks.onEvent({ type: 'tool-result', name: t.name, summary, callId, args: input, result, kind: t.kind })
          return result
        }
      }
    })
  }
  return set
}
