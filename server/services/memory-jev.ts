// Score unreviewed memories with Jev so the review queue can put the likely junk first.
//
// Deliberately narrow: this ONLY reads memories and writes four jev_* columns. It never
// archives, never marks anything reviewed, and never touches `confidence`. The calibration
// behind it supports an ORDERING, not a decision — see server/lib/memory/jev-score.ts.

import { and, isNull, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { memories } from '../db/schema'
import { askJev, nouls, JEV_MODEL, JevNotConfiguredError } from '../lib/ai/jev'
import { JEV_QUESTIONS, jevKeepScore, type JevAnswers } from '../lib/memory/jev-score'

/** 8 has hit 429s before on this API; stay under it. */
const CONCURRENCY = 6

export interface JevScoreRunResult {
  considered: number
  scored: number
  failed: number
  skipped?: 'not-configured'
}

/**
 * Score up to `limit` unreviewed, unscored, live memories.
 *
 * Targets UNREVIEWED memories only — the score exists to order the review queue, and
 * re-scoring the 2,500 already-reviewed ones would spend money to sort a list nobody opens.
 * Already-scored rows are skipped via `jev_scored_at IS NULL`, so repeated runs walk
 * forward through the backlog instead of redoing it.
 */
export async function runJevScoring(opts: { limit?: number } = {}): Promise<JevScoreRunResult> {
  const limit = opts.limit ?? 50
  if (!process.env.JEV_KEY) return { considered: 0, scored: 0, failed: 0, skipped: 'not-configured' }

  const db = useDb()
  const rows = await db.select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(and(
      isNull(memories.reviewedAt),
      isNull(memories.archivedAt),
      isNull(memories.jevScoredAt)
    ))
    .orderBy(sql`${memories.createdAt} desc`)
    .limit(limit)

  if (!rows.length) return { considered: 0, scored: 0, failed: 0 }

  let scored = 0
  let failed = 0
  const queue = [...rows]

  async function worker() {
    for (;;) {
      const row = queue.shift()
      if (!row) return
      try {
        const answers = nouls(await askJev(row.content, JEV_QUESTIONS))
        const score = jevKeepScore(answers as Partial<JevAnswers>)
        // A partial response scores null. Still stamp jevScoredAt so the row is not retried
        // forever — the raw answers are kept either way, so a later weighting can revisit it.
        await db.update(memories)
          .set({ jevScore: score, jevAnswers: answers, jevScoredAt: new Date(), jevModel: JEV_MODEL })
          .where(sql`${memories.id} = ${row.id}`)
        scored++
      } catch (err) {
        // Leave the row UNSTAMPED so the next run retries it. An unreachable Jev must not
        // permanently mark 50 memories as "scored, no score".
        if (err instanceof JevNotConfiguredError) throw err
        console.warn(`[jev] scoring ${row.id} failed:`, err)
        failed++
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
  return { considered: rows.length, scored, failed }
}
