// server/lib/agent/types.ts
import type { ZodRawShape } from 'zod'

/** Per-call context handed to every tool handler. */
export interface ToolContext {
  signal: AbortSignal           // aborts when the caller (Unmute) hangs up / barge-in
}

/** What a tool handler returns. `undo` (when present) reverses the side-effect. */
export interface ToolExecution {
  result: unknown               // structured result fed back to the model
  summary: string               // short spoken/UI-friendly line, e.g. "added 'buy milk' to todo"
  undo?: () => Promise<void>     // present for create/destructive tools
}

export type ToolKind = 'read' | 'create' | 'destructive'

export interface AgentTool {
  name: string
  description: string
  schema: ZodRawShape           // → OpenAI tool JSON schema AND MCP registration
  kind: ToolKind
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolExecution>
}

/** Events the loop yields to its HTTP adapter. */
export type LoopEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; name: string; summary: string; undoToken?: string }
  | { type: 'done' }

/** Events published on the activity bus for the client side-channel. */
export type ActivityEvent =
  | { type: 'state'; state: 'idle' | 'thinking' | 'tool' }
  | { type: 'tool'; name: string; summary: string; undoToken?: string }
