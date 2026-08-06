// server/lib/agent/tool-history.ts
//
// Pure core for structural tool-history. Deliberately imports NOTHING from
// run.ts (that would be circular) and nothing from the DB or the AI SDK, so
// every rule below is unit-testable with plain objects.
import type { ToolKind } from './types'

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
  return { truncated: true, bytes: json.length, preview: json.slice(0, max) }
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
        // already tolerates it, `rowToAgentMessage` promises never to throw on bad tool_calls,
        // and /api/agent/chat.post.ts forwards an unvalidated client-supplied `messages` array
        // straight into runAgent. Pass it through untouched — toolBlocksFor drops it later.
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
