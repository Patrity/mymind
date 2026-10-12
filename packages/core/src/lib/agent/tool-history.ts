// server/lib/agent/tool-history.ts
//
// Pure core for structural tool-history. Deliberately imports NOTHING from
// run.ts (that would be circular) and nothing from the DB or the AI SDK, so
// every rule below is unit-testable with plain objects.
import type { ToolKind } from './types'
import type { SubagentStep } from '../../shared/types/agent-ui'
import { TAINT_SOURCES, type OutputWarningDTO, type RunTaint, type TaintFlag, type TaintSource, type ToolApprovalNote } from './judge/types'

/** One tool invocation, normalized. Persisted additively onto conversation_messages.tool_calls. */
export interface AgentToolRecord {
  callId: string                      // AI SDK execute() opts.toolCallId — the pairing key
  name: string
  kind: ToolKind
  args: Record<string, unknown>
  result: unknown
  summary: string                     // existing chip text
  undoToken?: string
  textOffset: number                  // assistantText.length when the call fired
  /** A subagent's nested calls (terminal states only). toolBlocksFor ignores it: display-only. */
  steps?: SubagentStep[]
  /** Cycle 84: the judge approved this call (Smart Approvals) — display-only, never sent to the model. */
  approval?: ToolApprovalNote
  /** Cycle 84 Task 3: the output guard flagged this result — display-only (the model sees the
   *  warning inside `result`). */
  outputWarning?: OutputWarningDTO
}

/** Tool-bearing assistant turns whose results survive into model history. */
export const TOOL_HISTORY_WINDOW = 3
/** Replay cap for `read` results — mirrors session-read.ts's CONTENT_CAP precedent. */
export const READ_RESULT_CAP = 1500
/** Persist-time ceiling, generous so the replay cap can be retuned with no backfill. */
export const WRITE_RESULT_CAP = 8192
/**
 * Persist-time ceiling for a call's ARGUMENTS — the same two-tier shape as the result caps.
 * Args are NOT cheap: the write tools take unbounded strings (`save_document.content`,
 * `update_document`/`sync_document.content`, `edit_document.old_string`/`new_string`,
 * `create_skill.body`), and this is a document manager, so 60 KB bodies are routine. Left
 * generous relative to the replay cap so that cap can be retuned with no backfill.
 */
export const ARGS_WRITE_CAP = 4096
/**
 * Replay cap for arguments — what the model actually re-reads for an in-window call. The
 * anti-fabrication signal is "this call happened, roughly with this input": a query, a path,
 * an id, a title all fit in a few hundred chars. Also bounds rows written before the write
 * cap existed, since this runs at the single replay call site.
 */
export const ARGS_REPLAY_CAP = 1024

/**
 * Shrink an oversized result to a preview. Returns the ORIGINAL object by identity when it
 * already fits, so callers can cheaply detect "unchanged". Never throws — a circular or
 * otherwise unserializable result degrades to a marker rather than killing the turn.
 */
export function capResult(result: unknown, max: number): unknown {
  let json: string
  try {
    json = JSON.stringify(result) ?? ''
  } catch {
    return { unserializable: true }
  }
  if (json.length <= max) return result
  // Cycle 82 fix round 1 (verified ⚠a): a result is capped TWICE — at capture (WRITE_RESULT_CAP)
  // and again by the history policy (READ_RESULT_CAP) — and the second cap's preview starts with the
  // FIRST cap's keys, so a "flag first in the preview" marker did not survive. The workspace-taint
  // flag is therefore lifted onto every capped shape, however often it is re-capped.
  // Cycle 84 Task 3: the output guard's warning is lifted the same way — the model must keep reading
  // it, and its presence taints the next run (historyCarriesTaint).
  const warning = injectionWarningOf(result)
  return {
    ...(carriesWorkspaceTaint(result) ? { workspaceTainted: true } : {}),
    ...(warning !== null ? { injectionWarning: warning } : {}),
    truncated: true, bytes: json.length, preview: json.slice(0, max)
  }
}

/**
 * `capResult` for an arguments object. A truncated payload becomes
 * `{ truncated, bytes, preview }` — still a `Record<string, unknown>`, and the AI SDK types
 * `ToolCallPart.input` as `unknown`, so the replayed call part stays valid either way.
 * Returns the ORIGINAL object by identity when it already fits (same contract as capResult).
 */
export function capArgs(args: Record<string, unknown> | undefined, max: number): Record<string, unknown> {
  if (args === undefined) return {}
  return capResult(args, max) as Record<string, unknown>
}

/** Serialized size, never throwing — a circular/unserializable value reports 0. */
function byteLen(v: unknown): number {
  try { return (JSON.stringify(v) ?? '').length } catch { return 0 }
}

function capForKind(kind: ToolKind): number {
  // `read` returns the bulk content (search hits, file bodies, fetched pages) — cap it.
  // create/destructive mostly return body-free receipts (cycle 52's write receipts), so they
  // stay whole here. The one outlier is `exec` (kind: 'destructive'), which returns full
  // stdout/stderr; what bounds that is WRITE_RESULT_CAP at capture, not this function.
  return kind === 'read' ? READ_RESULT_CAP : Infinity
}

/**
 * Tier + decay. Walks newest-to-oldest counting only TOOL-BEARING assistant turns, so
 * ordinary chat turns never consume the window.
 *
 * The CALL always survives for the life of the conversation — `callId` + `name` are the
 * anti-fabrication signal and cost ~50 tokens. Both PAYLOADS decay: the result, and (since
 * a write tool's args carry the whole document body) the args too.
 */
export function applyHistoryPolicy<T extends { role: string; toolRecords?: AgentToolRecord[] }>(
  messages: T[]
): T[] {
  let toolTurnsSeen = 0
  const out = new Array<T>(messages.length)

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (!m.toolRecords?.length) { out[i] = m; continue }

    toolTurnsSeen++
    const withinWindow = toolTurnsSeen <= TOOL_HISTORY_WINDOW

    out[i] = {
      ...m,
      toolRecords: m.toolRecords.map(r => {
        // Malformed jsonb (a null or primitive element) must not 500 the turn: `toolBlocksFor`
        // already tolerates it, and `rowToAgentMessage` promises never to throw on bad tool_calls
        // (the unvalidated /api/agent/chat caller was deleted in cycle 81; the tolerance stays).
        // Pass it through untouched — toolBlocksFor drops it later.
        if (!r || typeof r !== 'object') return r
        if (!withinWindow) {
          // Out of window: keep the CALL (callId + name), shed BOTH payloads. An uncapped
          // args blob would otherwise sit in the prompt for the life of the conversation.
          return { ...r, args: { elided: true, bytes: byteLen(r.args) }, result: { elided: true, bytes: byteLen(r.result) } }
        }
        const args = capArgs(r.args, ARGS_REPLAY_CAP)
        const result = capResult(r.result, capForKind(r.kind))
        return args === r.args && result === r.result ? r : { ...r, args, result }
      })
    }
  }
  return out
}

/**
 * Expand records into AI SDK message blocks: assistant(tool-call parts) → tool(tool-result
 * parts), one pair per distinct textOffset so a multi-step turn replays in step order.
 * Calls sharing an offset (parallel calls in one step) group into a single pair.
 *
 * INVARIANT: a tool-result is only ever emitted alongside its call. Providers reject an
 * unpaired toolCallId, so an elided result still emits its tool message — and a legacy
 * record with no callId emits NOTHING at all rather than an unpaired half.
 */
export function toolBlocksFor(
  records: AgentToolRecord[]
): { role: 'assistant' | 'tool'; content: unknown[] }[] {
  const usable = records.filter(r => r?.callId)
  if (!usable.length) return []

  const blocks: { role: 'assistant' | 'tool'; content: unknown[] }[] = []
  let group: AgentToolRecord[] = []

  const flush = () => {
    if (!group.length) return
    blocks.push({
      role: 'assistant',
      content: group.map(r => ({
        type: 'tool-call', toolCallId: r.callId, toolName: r.name, input: r.args
      }))
    })
    blocks.push({
      role: 'tool',
      content: group.map(r => ({
        type: 'tool-result', toolCallId: r.callId, toolName: r.name,
        output: { type: 'json', value: r.result }
      }))
    })
    group = []
  }

  for (const r of usable) {
    if (group.length && r.textOffset !== group[0]!.textOffset) flush()
    group.push(r)
  }
  flush()
  return blocks
}

/**
 * Did a call's result put real data in the model's context? Not for an `{ error }`, a denial
 * (`{ denied: true }`) or a headless proposal receipt (`{ proposed: true }`) — none of those
 * carry the tool's payload. Shared by the live taint flip (ai-tools.ts) and the history seed
 * below, so the two can't disagree about what "produced content" means.
 */
export function producedContent(result: unknown): boolean {
  if (!result || typeof result !== 'object') return true
  const r = result as Record<string, unknown>
  return !('error' in r) && r.denied !== true && r.proposed !== true
}

/** Cycle 82: a workspace tool result read from a TAINTED workspace (it handled mail/calendar
 *  content) — `{ workspaceTainted: true, … }`, the flag first so a capped preview still starts with
 *  it. Such a result taints the run like a `taints` tool's content does. */
export function carriesWorkspaceTaint(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const r = result as Record<string, unknown>
  if (r.workspaceTainted === true) return true
  return r.truncated === true && typeof r.preview === 'string' && r.preview.startsWith('{"workspaceTainted":true')
}

/** Cycle 84 Task 3: the output guard's warning on a flagged result (judge/guard.ts wrapFlagged puts
 *  it at the top level, capResult keeps it there) — null when the result was not flagged. */
export function injectionWarningOf(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const w = (result as Record<string, unknown>).injectionWarning
  return typeof w === 'string' ? w : null
}

/** The output guard's warning starts with this (judge/guard.ts guardWarning). */
export const GUARD_WARNING_LEAD = '⚠ This content appears to contain instructions aimed at you'

/** A result the output guard flagged: it taints the run that reads it, like mail content does. */
export function carriesInjectionWarning(result: unknown): boolean {
  return injectionWarningOf(result) !== null
}

/** applyHistoryPolicy's out-of-window marker: the result is gone from the prompt. */
function isElided(result: unknown): boolean {
  return !!result && typeof result === 'object' && (result as Record<string, unknown>).elided === true
}

/**
 * Cycle 79b (a) cross-turn taint: does the history the model will ACTUALLY see still carry a
 * `taints` tool's content — or (cycle 82) a tainted workspace's output, or (cycle 84) a result the
 * output guard flagged? Takes the POLICED messages (applyHistoryPolicy output) so "in context" means exactly what the prompt holds: an out-of-window (elided) result, an error/denial, or a
 * legacy record with no callId (toolBlocksFor drops it) does not count; a capped preview does.
 */
export function historyCarriesTaint(
  policed: { role: string; toolRecords?: AgentToolRecord[]; content?: unknown }[],
  tainting: ReadonlySet<string>
): boolean {
  return historyTaint(policed, tainting).sources.length > 0
}

/**
 * Task 4 fix round 0 (C1/C2): the same check as historyCarriesTaint, saying WHY — which taint sources
 * the visible history carries, and the guard flags (with their reasons, from the tool record's
 * `outputWarning`) behind a `flagged` source. Sources come back in TAINT_SOURCES order.
 */
export function historyTaint(
  policed: { role: string; toolRecords?: AgentToolRecord[]; content?: unknown }[],
  tainting: ReadonlySet<string>
): RunTaint {
  const sources = new Set<TaintSource>()
  const flags: TaintFlag[] = []
  for (const m of policed) {
    // Fix round 1 (M4): guarded text delivered as an event (a watch's output) carries the warning in
    // the message itself — it taints like a flagged tool result.
    if (m.role !== 'assistant') {
      if (textOf(m.content).includes(GUARD_WARNING_LEAD)) sources.add('flagged')
      continue
    }
    for (const r of m.toolRecords ?? []) {
      if (!r || typeof r !== 'object' || !r.callId) continue
      if (isElided(r.result)) continue
      if (carriesWorkspaceTaint(r.result)) sources.add('workspace')
      if (carriesInjectionWarning(r.result)) {
        sources.add('flagged')
        if (r.outputWarning) flags.push({ tool: r.name, source: r.outputWarning.source, reasons: [...r.outputWarning.reasons] })
      }
      if (tainting.has(r.name) && producedContent(r.result)) sources.add('mail')
    }
  }
  return { sources: TAINT_SOURCES.filter(x => sources.has(x)), flags }
}

/** A message's text, whatever its shape (a string, or content parts). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(p => (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : '')).join('\n')
}
