// server/lib/agent/ai-tools.ts
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { AgentTool, ToolContext, ApprovalRequest } from './types'
import { publishActivity } from './bus'
import { registerUndo } from './undo'
import { withSpan } from '../observability/record'

export interface RunHooks {
  signal: AbortSignal
  requestApproval?: (req: ApprovalRequest) => Promise<{ approved: boolean }>
  onEvent: (e:
    | { type: 'tool-start'; name: string; args: Record<string, unknown> }
    | { type: 'tool-result'; name: string; summary: string; undoToken?: string }) => void
}

function approvalRequestFor(t: AgentTool, input: Record<string, unknown>): ApprovalRequest {
  if (t.describeApproval) return t.describeApproval(input)
  return { tool: t.name, command: JSON.stringify(input), proposedPattern: `${t.name} *` }
}

/** Adapt the agent tool registry into an AI SDK ToolSet (execute = gate + handler + bus + undo). */
export function buildAiTools(registry: AgentTool[], hooks: RunHooks): ToolSet {
  const ctx: ToolContext = { signal: hooks.signal, requestApproval: hooks.requestApproval }
  const set: ToolSet = {}
  for (const t of registry) {
    set[t.name] = tool({
      description: t.description,
      inputSchema: z.object(t.schema),
      execute: async (input: Record<string, unknown>) => {
        hooks.onEvent({ type: 'tool-start', name: t.name, args: input })
        // Dangerous tools pause for human approval BEFORE the handler runs.
        if (t.dangerous) {
          const decision = ctx.requestApproval
            ? await ctx.requestApproval(approvalRequestFor(t, input))
            : { approved: false } // fail-safe: no channel → auto-deny
          if (decision.approved !== true) {
            const summary = `denied: ${t.name}`
            publishActivity({ type: 'tool', name: t.name, summary })
            hooks.onEvent({ type: 'tool-result', name: t.name, summary })
            return { denied: true }
          }
        }
        try {
          const exec = await withSpan(
            { kind: 'tool', name: t.name, request: input as Record<string, unknown> },
            () => t.handler(input, ctx)
          )
          const undoToken = exec.undo ? registerUndo(exec.undo) : undefined
          publishActivity({ type: 'tool', name: t.name, summary: exec.summary, undoToken })
          hooks.onEvent({ type: 'tool-result', name: t.name, summary: exec.summary, undoToken })
          return exec.result
        } catch (err) {
          const summary = `failed: ${t.name}`
          publishActivity({ type: 'tool', name: t.name, summary })
          hooks.onEvent({ type: 'tool-result', name: t.name, summary })
          return { error: (err as Error).message }
        }
      }
    })
  }
  return set
}
