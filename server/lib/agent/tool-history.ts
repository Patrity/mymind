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

function capForKind(kind: ToolKind): number {
  // create/destructive already return body-free receipts (cycle 52) — keep them whole.
  return kind === 'read' ? READ_RESULT_CAP : Infinity
}

/**
 * Tier + decay. Walks newest-to-oldest counting only TOOL-BEARING assistant turns, so
 * ordinary chat turns never consume the window.
 *
 * The CALL always survives for the life of the conversation — it is the anti-fabrication
 * signal and costs ~50 tokens. Only the RESULT decays.
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
        if (!withinWindow) {
          let bytes = 0
          try { bytes = (JSON.stringify(r.result) ?? '').length } catch { bytes = 0 }
          return { ...r, result: { elided: true, bytes } }
        }
        const capped = capResult(r.result, capForKind(r.kind))
        return capped === r.result ? r : { ...r, result: capped }
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
