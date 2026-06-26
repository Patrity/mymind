// server/lib/agent/types.ts
import type { ZodRawShape } from 'zod'
import type { DisplayImage } from './image-embed'

/** A dangerous-tool approval request surfaced to the human. */
export interface ApprovalRequest {
  tool: string        // e.g. 'exec'
  command: string     // the exact thing that will run / change
  proposedPattern: string // an "always allow" suggestion (editable in the UI)
}

/** Per-call context handed to every tool handler. */
export interface ToolContext {
  signal: AbortSignal // aborts when the caller hangs up / barge-in
  // Present only on the interactive (WS) path; a dangerous tool with no channel auto-denies.
  requestApproval?: (req: ApprovalRequest) => Promise<{ approved: boolean }>
}

/** What a tool handler returns. `undo` (when present) reverses the side-effect. */
export interface ToolExecution {
  result: unknown // structured result fed back to the model
  summary: string // short spoken/UI-friendly line, e.g. "added 'buy milk' to todo"
  undo?: () => Promise<void> // present for create/destructive tools
  display?: { images: DisplayImage[] } // server-authored embeds; the model never receives the URL
}

export type ToolKind = 'read' | 'create' | 'destructive'

export interface AgentTool {
  name: string
  description: string
  schema: ZodRawShape // → OpenAI tool JSON schema AND MCP registration
  kind: ToolKind
  dangerous?: boolean // requires human approval before the handler runs
  // Derive the approval request from the call args (tool-agnostic gate). Defaults
  // to a JSON-of-args command + `<name> *` pattern when omitted.
  describeApproval?: (args: Record<string, unknown>) => ApprovalRequest
  /** Optional per-tool fast-path: return true to run WITHOUT a human prompt (gate still applies to false). */
  autoApprove?: (input: Record<string, unknown>, ctx: ToolContext) => boolean | Promise<boolean>
  /**
   * Optional hook to redact sensitive values from the input before it is written to the
   * audit log (activity_log). The model-visible result is unchanged — only the logged
   * request is masked. Omit to log the raw input.
   */
  redactForLog?: (input: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolExecution>
}

/** Events the loop yields to its HTTP adapter. */
export type LoopEvent
  = | { type: 'text-delta', text: string }
    | { type: 'tool-start', name: string, args: Record<string, unknown> }
    | { type: 'tool-result', name: string, summary: string, undoToken?: string, images?: DisplayImage[] }
    | { type: 'done' }

/** Events published on the activity bus for the client side-channel. */
export type ActivityEvent
  = | { type: 'state', state: 'idle' | 'thinking' | 'tool' }
    | { type: 'tool', name: string, summary: string, undoToken?: string }
