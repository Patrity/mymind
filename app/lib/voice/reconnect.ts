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
}

export function framesOnOpen(i: OpenFrameInput): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [{ type: 'preset', presetId: i.presetId }]
  if (i.modelDefId) frames.push({ type: 'model', modelDefId: i.modelDefId })
  if (i.conversationId) {
    frames.push({ type: 'load', conversationId: i.conversationId })
    if (i.shouldAttach(i.conversationId)) frames.push({ type: 'attach' })
  }
  return frames
}
