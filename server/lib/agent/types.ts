// server/lib/agent/types.ts
import type { ZodRawShape } from 'zod'
import type { DisplayImage } from './image-embed'
import type { UndoFn } from './undo'
import type { ToolsetId } from './toolsets'

/** A single content part in a multimodal agent message. */
export type AgentContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mediaType: string }

/** A dangerous-tool approval request surfaced to the human. */
export interface ApprovalRequest {
  tool: string        // e.g. 'exec'
  command: string     // the exact thing that will run / change
  proposedPattern: string // an "always allow" suggestion (editable in the UI)
  callId?: string // the SDK toolCallId — lets the UI render the approval on that tool part
  /** The call's recorded (masked) args, so the approval card renders them even when the
   *  approval request reaches the UI stream before the call's tool-start. */
  args?: Record<string, unknown>
  /** Set by buildAiTools from the TOOL (never from describeApproval): only then may a persisted
   *  allowlist pattern auto-approve it, or an "always allow" be saved for it. */
  allowlistable?: boolean
  /** Per-tool card heading, shown instead of the generic "Run this?" (cycle 79 review m1) — e.g.
   *  gmail_send's "Send this email?". Omit to keep the generic wording. */
  title?: string
  /** A body-free stand-in for `command`, logged to activity_log INSTEAD OF it when present
   *  (cycle 79 review I4). `command` itself may carry sensitive/untrusted content (gmail_send's
   *  exact draft body) that the global constraint forbids writing to activity_log — every
   *  recorder of an approval OUTCOME (server/api/voice/ws.ts, server/lib/channels/approvals.ts's
   *  logOutcome) must log `logSummary ?? command`, never `command` unconditionally. This does
   *  NOT apply to the text actually SHOWN to the human approving it (the web card, the iMessage
   *  prompt) — those still render the real `command` so the approval is informed. */
  logSummary?: string
}

/** Per-call context handed to every tool handler. */
export interface ToolContext {
  signal: AbortSignal // aborts when the caller hangs up / barge-in
  // Present only on the interactive (WS) path; a dangerous tool with no channel auto-denies.
  requestApproval?: (req: ApprovalRequest) => Promise<{ approved: boolean }>
  attachmentImageIds?: string[]  // image attachments of the current turn (edit_image source)
  /** The agent_runs row this call belongs to (runtime runner path only; absent on MCP / legacy
   *  callers). Lets a tool stamp revisions with the run and tell a job-fired run from others. */
  runId?: string
  /** A tool that runs its own agent loop (a subagent) reports each nested call here; ai-tools
   *  re-emits it as a `subagent-event` keyed to THIS call's toolCallId. */
  onNestedEvent?: (e: NestedToolEvent) => void
  /** Cycle 78: load on-demand toolsets for the rest of this run (+ persisted by the runner). Absent on MCP. */
  loadToolsets?: (ids: import('./toolsets').ToolsetId[]) => import('./toolsets').ToolsetId[]
  /** The SDK's toolCallId for THIS call. UI CORRELATION ONLY (matching an approval card to its
   *  tool-call part) — never use it to bind a security-sensitive side effect to one specific
   *  approval request. It comes from the model/provider and is not guaranteed unique or even
   *  non-empty: some openai-compatible backends return `id: ""`, or reuse a deterministic id
   *  (e.g. `call_0`) across different calls in the same turn (cycle 79 review round 3, N1) — both
   *  would collapse two different approval requests onto the same key. Use `approvalNonce` for
   *  that instead. Absent outside the interactive runner path (e.g. MCP), same as runId; `''`
   *  (not `undefined`) when the SDK supplies no id. */
  callId?: string
  /** A fresh, server-minted v4 UUID buildAiTools generates for THIS execution — never empty,
   *  never reused across calls, independent of whatever (or nothing) the SDK's own `callId`
   *  supplied (cycle 79 review round 3, N1 — see `callId`'s doc for why that one can't be
   *  trusted for this). This is what a tool binds a side effect to the EXACT approval request
   *  that authorized it with — e.g. gmail_send's TOCTOU pin. Absent outside the interactive
   *  runner path, same as runId. */
  approvalNonce?: string
}

export type ToolStartEvent = { type: 'tool-start'; name: string; args: Record<string, unknown>; callId?: string }
export type ToolResultEvent = { type: 'tool-result'; name: string; summary: string; undoToken?: string; images?: DisplayImage[]; callId?: string; args?: Record<string, unknown>; result?: unknown; kind?: ToolKind }
export type NestedToolEvent = ToolStartEvent | ToolResultEvent
export type SubagentEvent = { type: 'subagent-event'; parentCallId: string; event: NestedToolEvent }

/** What a tool handler returns. `undo` (when present) reverses the side-effect. */
export interface ToolExecution {
  result: unknown // structured result fed back to the model
  summary: string // short spoken/UI-friendly line, e.g. "added 'buy milk' to todo"
  undo?: UndoFn // present for create/destructive tools
  display?: { images: DisplayImage[] } // server-authored embeds; the model never receives the URL
}

export type ToolKind = 'read' | 'create' | 'destructive'

export interface AgentTool {
  name: string
  description: string
  schema: ZodRawShape // → OpenAI tool JSON schema AND MCP registration
  kind: ToolKind
  /** Cycle 78: which toolset this tool belongs to (visibility only — see toolsets.ts). */
  toolset: ToolsetId
  dangerous?: boolean // requires human approval before the handler runs
  /** Opt-in: a persisted "always allow" pattern may approve this dangerous tool without asking.
   *  Only exec sets it — decide_review (cycle 76) must be confirmed on every call. */
  allowlistable?: boolean
  // Derive the approval request from the call args (tool-agnostic gate). Defaults
  // to a JSON-of-args command + `<name> *` pattern when omitted. May be async: a tool whose
  // card needs to show live state (gmail_send fetches the real draft rather than trusting args)
  // returns a Promise; buildAiTools awaits it before the human ever sees the request.
  // `meta.approvalNonce` is a fresh, server-minted id for THIS specific call (cycle 79 review
  // round 3) — deliberately NOT the SDK's toolCallId, which may be empty or reused across
  // different calls (see ToolContext.callId's doc). A tool whose card content can go stale
  // before approval (gmail_send re-fetching a draft that might be edited again in the meantime)
  // binds its fingerprint to THIS nonce, not to the draft and not to the SDK's own id, so a
  // denied approval's state can never leak into a different, later approval of the same draft.
  // Tools that don't need it (exec, decide_review) simply ignore the parameter.
  describeApproval?: (args: Record<string, unknown>, meta: { approvalNonce: string }) => ApprovalRequest | Promise<ApprovalRequest>
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
    | { type: 'tool-result', name: string, summary: string, undoToken?: string, images?: DisplayImage[], callId?: string, args?: Record<string, unknown>, result?: unknown, kind?: ToolKind }
    | { type: 'done' }

/** Events published on the activity bus for the client side-channel. */
export type ActivityEvent
  = | { type: 'state', state: 'idle' | 'thinking' | 'tool' }
    | { type: 'tool', name: string, summary: string, undoToken?: string }
