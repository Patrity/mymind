// app/lib/voice/resume.ts
// Cycle 81: runs execute in the agent worker, so a web restart (a deploy, `nuxt dev` reloading its
// server) no longer ends the turn on screen — only this socket. Every run frame the server forwards
// carries `run` + `seq` (server/api/voice/ws.ts); this remembers the highest seq rendered per run of
// the thread whose turn is on screen, so the auto-reconnect can `attach` with `after` and the server
// replays just past it — no duplicates, and a run that finished during the outage sends its tail
// (finish + `persisted`, which re-reads the persisted turn). Pure, so the contract is testable.

export interface ResumePoint {
  conversationId: string
  /** runId → last seq rendered; empty when nothing of the thread's runs was seen yet. */
  after: Record<string, number>
}

export interface ResumeTracker {
  /** A conversation-scoped frame this client ACCEPTED (not a foreign straggler). */
  observe(m: { cid?: string; run?: unknown; seq?: unknown }): void
  /** Where to resume: the viewed thread, or — for a brand-new thread whose id has not landed yet —
   *  the thread its running turn's frames named. */
  point(viewed: string | null): ResumePoint | null
  /** A genuine thread switch: what was rendered no longer applies. */
  clear(): void
}

const MAX_RUNS = 20

export function createResumeTracker(): ResumeTracker {
  let cid: string | null = null
  const runs = new Map<string, number>()
  return {
    observe(m) {
      if (!m.cid || typeof m.run !== 'string' || typeof m.seq !== 'number') return
      if (m.cid !== cid) { cid = m.cid; runs.clear() }
      runs.set(m.run, Math.max(runs.get(m.run) ?? 0, m.seq))
      if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!)
    },
    point(viewed) {
      const target = viewed ?? cid
      if (!target) return null
      return { conversationId: target, after: target === cid ? Object.fromEntries(runs) : {} }
    },
    clear() { cid = null; runs.clear() }
  }
}
