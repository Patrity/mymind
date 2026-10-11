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
