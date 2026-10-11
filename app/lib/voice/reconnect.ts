// app/lib/voice/reconnect.ts
// What a freshly OPENED socket must send before anything else. Pure, so the reconnect contract
// is testable without a WebSocket.
//
// Every open — first connect AND every reconnect (deploy restart, laptop sleep, a phone
// backgrounding the tab) — gets a brand-new server socket whose view is null. Before cycle 73's
// final review (C1) the client re-sent only its voice/model picks, so the next typed message
// started a NEW thread the client never saw: its cid guard dropped every frame, even the
// `conversation` frame. Re-sending `load` + `attach` for the thread on screen restores the
// server's view and live subscription (attach replays a turn still running there).

export interface OpenFrameInput {
  presetId: string
  modelDefId: string | null
  /** The thread on screen, or null (nothing viewed yet / a new thread with no id). */
  conversationId: string | null
  /** turns.shouldAttach — records the attach so the page's own attach() for the same thread
   *  does not replay the running turn a second time. Call only after turns.reset(). */
  shouldAttach: (conversationId: string) => boolean
  /** Cycle 81: an AUTO-reconnect after the socket dropped mid-session (web restart / deploy) —
   *  where to resume (lib/voice/resume.ts). Its thread wins when nothing is viewed yet (a new
   *  thread whose first turn is still running), and `after` rides on the attach so the server
   *  replays each run just past what was rendered. */
  resume?: { conversationId: string; after: Record<string, number> } | null
}

export function framesOnOpen(i: OpenFrameInput): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [{ type: 'preset', presetId: i.presetId }]
  if (i.modelDefId) frames.push({ type: 'model', modelDefId: i.modelDefId })
  const id = i.conversationId ?? i.resume?.conversationId ?? null
  if (id) {
    frames.push({ type: 'load', conversationId: id })
    const after = i.resume?.conversationId === id && Object.keys(i.resume.after).length ? i.resume.after : null
    if (i.shouldAttach(id)) frames.push(after ? { type: 'attach', after } : { type: 'attach' })
  }
  return frames
}

// ── Auto-reconnect pacing (cycle 81 Task 6 carry-over) ──────────────────────────────────────────

export const RECONNECT_BASE_MS = 500
export const RECONNECT_MAX_MS = 8_000
/** After this many reconnect attempts without an open socket, the page says "Reconnecting…". */
export const RECONNECTING_AFTER = 3

/**
 * The wait before reconnect attempt `attempt` (0-based): exponential from 500ms, capped at 8s, with
 * jitter — a random 50–100% of that — so every tab of a restarted server does not knock at once.
 * `rand` is Math.random() (in [0, 1)).
 */
export function reconnectDelay(attempt: number, rand: number): number {
  const ceiling = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt), RECONNECT_MAX_MS)
  return Math.round(ceiling * (0.5 + 0.5 * Math.min(Math.max(rand, 0), 1)))
}

/**
 * A browser never shows a WebSocket upgrade's 401, so after a failed reconnect the page asks the
 * auth endpoint. Expired = the server ANSWERED and said there is no session; a failed request
 * (server still down) is not expired — keep retrying.
 */
export function sessionExpired(r: { data?: { session?: unknown } | null; error?: unknown } | null | undefined): boolean {
  if (!r || r.error) return false
  return !r.data?.session
}
