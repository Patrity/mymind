import { recoverOrphans } from './runs'
import { requeueUnconsumed } from './inbox'
import { appendEvent } from '../../../services/conversations'

/** Any run still 'running' with a stale liveness stamp died with the old process. Mark it, say
 *  so in its thread, and requeue whatever it never read — a fast restart drops a run mid-turn
 *  just as completely as an abort does, and Tony's words are never silently dropped regardless
 *  of why the run ended (Task 8 review, fix round 1: recovery was requeueing nothing, so for
 *  the whole ~65s fast-restart window his messages were steered into a run that was already
 *  dead). No automatic retry of the turn itself — a half-run tool loop is not safely repeatable.
 *  Shared by `recoverOnBoot` (once, at startup) and `recoverStale` (every worker tick) — same
 *  query, same note, same requeue, different caller. */
async function recoverAndNote(opts: { onlyConversations?: string[]; excludeRunIds?: string[] } = {}): Promise<number> {
  const dead = await recoverOrphans({ onlyConversations: opts.onlyConversations, excludeRunIds: opts.excludeRunIds })
  for (const r of dead) {
    await appendEvent(r.conversationId, 'A turn was interrupted by a restart and did not finish.', 'runtime:restart')
      .catch(err => console.error('[runtime] recovery note failed:', err))
    await requeueUnconsumed(r)
      .catch(err => console.error('[runtime] recovery requeue failed:', err))
  }
  return dead.length
}

/** On boot: catches whatever died with the previous process. */
export async function recoverOnBoot(opts: { onlyConversations?: string[]; excludeRunIds?: string[] } = {}): Promise<number> {
  return recoverAndNote(opts)
}

/** On every worker tick (Task 2 review ruling): a fast restart (<60s) can leave a stale
 *  'running' row that boot recovery never sees (it only runs once, at startup) — that row
 *  would otherwise block its conversation's queue forever, since enqueue steers into
 *  whatever `activeRunFor` reports as running. Same 60s ORPHAN_STALE_MS threshold as boot;
 *  callers must NEVER pass staleMs:0 here — the dev DB is shared with other checkouts'
 *  live processes, and a 0ms threshold would recover runs that are merely between
 *  alive_at bumps (bumped every 10s), not actually dead. `excludeRunIds` is queue.ts's
 *  in-process `executing` set (Task 8 review, fix round 1) — never let this process's own
 *  periodic tick recover a run IT is still actively running. */
export async function recoverStale(opts: { onlyConversations?: string[]; excludeRunIds?: string[] } = {}): Promise<number> {
  return recoverAndNote(opts)
}
