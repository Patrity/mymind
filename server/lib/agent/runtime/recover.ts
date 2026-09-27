import { recoverOrphans } from './runs'
import { appendEvent } from '../../../services/conversations'

/** Any run still 'running' with a stale liveness stamp died with the old process. Mark it and
 *  say so in its thread. No automatic retry — a half-run tool loop is not safely repeatable.
 *  Shared by `recoverOnBoot` (once, at startup) and `recoverStale` (every worker tick) — same
 *  query, same note, different caller. */
async function recoverAndNote(opts: { onlyConversations?: string[] } = {}): Promise<number> {
  const dead = await recoverOrphans({ onlyConversations: opts.onlyConversations })
  for (const r of dead) {
    await appendEvent(r.conversationId, 'A turn was interrupted by a restart and did not finish.', 'runtime:restart')
      .catch(err => console.error('[runtime] recovery note failed:', err))
  }
  return dead.length
}

/** On boot: catches whatever died with the previous process. */
export async function recoverOnBoot(opts: { onlyConversations?: string[] } = {}): Promise<number> {
  return recoverAndNote(opts)
}

/** On every worker tick (Task 2 review ruling): a fast restart (<60s) can leave a stale
 *  'running' row that boot recovery never sees (it only runs once, at startup) — that row
 *  would otherwise block its conversation's queue forever, since enqueue steers into
 *  whatever `activeRunFor` reports as running. Same 60s ORPHAN_STALE_MS threshold as boot;
 *  callers must NEVER pass staleMs:0 here — the dev DB is shared with other checkouts'
 *  live processes, and a 0ms threshold would recover runs that are merely between
 *  alive_at bumps (bumped every 10s), not actually dead. */
export async function recoverStale(opts: { onlyConversations?: string[] } = {}): Promise<number> {
  return recoverAndNote(opts)
}
