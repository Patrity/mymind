// server/lib/agent/runtime/approvals.ts
// Interactive approval channels, keyed by RUN (not socket): ws.ts registers one for each run it
// originates and removes it on close. A run whose socket is gone gets today's no-channel
// behaviour — an immediate deny — instead of waiting out a 120s timeout nobody can see.
//
// The persisted exec ALLOWLIST is checked here, before any channel (Task 7 review ruling): it
// used to live in the socket's requestApproval, so an allowlisted command from a run whose tab
// had closed was denied. Now it applies whether or not a socket is still attached; the socket
// channel only does the interactive prompt. Only tools marked `allowlistable` (exec) consult it.
import type { ApprovalRequest } from '../types'
import { loadApprovals, touchApproval, matchesApproval } from '../../exec/approvals'
import { recordEvent } from '../../observability/record'
import type { TurnStream } from '../../voice/turn-stream'

type Channel = (req: ApprovalRequest) => Promise<{ approved: boolean }>
const channels = new Map<string, Channel>()
const streams = new Map<string, TurnStream>()

export function registerApprovalChannel(runId: string, fn: Channel): void {
  channels.set(runId, fn)
}
export function unregisterApprovalChannel(runId: string): void {
  channels.delete(runId)
}
export function hasApprovalChannel(runId: string): boolean {
  return channels.has(runId)
}
export function approvalFor(runId: string): Channel {
  return async (req) => {
    // Opt-in per tool (Task 9 review ruling): a saved pattern for a tool that isn't allowlistable
    // (e.g. decide_review) is ignored, so every such call still reaches a human.
    const patterns = req.allowlistable === true
      ? (await loadApprovals(req.tool)).filter(p => matchesApproval(req.command, [p.pattern]))
      : []
    if (patterns.length) {
      touchApproval(patterns[0]!.id).catch(() => {})
      recordEvent({ kind: 'tool', name: 'exec:approval', severity: 'info', meta: { outcome: 'allowlisted', command: req.command, pattern: patterns[0]!.pattern } })
      return { approved: true }
    }
    const ch = channels.get(runId)
    return ch ? ch(req) : { approved: false }
  }
}
export function registerTurnStream(runId: string, ts: TurnStream): void {
  streams.set(runId, ts)
}
export function turnStreamFor(runId: string): TurnStream | undefined {
  return streams.get(runId)
}
export function releaseTurnStream(runId: string): void {
  streams.delete(runId)
}
