// server/lib/agent/runtime/approvals.ts
// Interactive approval channels, keyed by RUN (not socket): ws.ts registers one for each run it
// originates and removes it on close. A run whose socket is gone gets today's no-channel
// behaviour — an immediate deny — instead of waiting out a 120s timeout nobody can see.
import type { ApprovalRequest } from '../types'
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
export function approvalFor(runId: string): Channel {
  return async (req) => {
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
