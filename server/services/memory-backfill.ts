// The dual-score backfill (cycle 77, spec D3 / §4): a resumable, capped walk that gives EVERY live
// memory — reviewed ones included — a Jev score and an extract-v3 audit. It does nothing until
// Tony flips the `memory_backfill` switch to `running` (so the spend starts when he says so), and
// runs from the `memory-backfill` task every 5 minutes after that.
//
// Resumable by construction: there is no cursor. Each run asks the DB which live rows still miss a
// part (selectUnscored), so a crash, a restart or a pause loses nothing. Completion is read ONLY
// from the DB state — `done` means selection came back empty — never from per-row outcomes (a
// transport failure leaves its rows selected for the next run).
//
// It writes nothing itself except the switch: the scoring goes through the one shared path
// (server/services/memory-scoring.ts) and its process-wide limiters, shared with the queue cron and
// new-memory scoring. No automatic action on memories (spec D5).

import { and, count, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import { useDb } from '../db'
import { memories } from '../db/schema'
import { AUDIT_PROMPT_VERSION } from '../lib/memory/extract-v3'
import {
  MEMORY_BACKFILL_KEY, getBackfillSetting, setBackfillState, type BackfillSetting
} from '../lib/memory/backfill-setting'
import { MAX_FAILURES, resolveJevCfg, scoreMemories, selectUnscored, type ScoreDeps } from './memory-scoring'
import { publishChange } from '../utils/live-bus'

/** Memories per run (spec §4: 40 every 5 minutes). */
export const BACKFILL_BATCH = 40

export interface BackfillProgress {
  state: BackfillSetting['state']
  /** Live memories. */
  total: number
  /** Live memories with a Jev score. */
  jevDone: number
  /** Live memories with an audit on the current prompt version. */
  auditDone: number
  /** Live memories with a part still missing that hit the failure cap (≥ 3) — no longer retried. */
  skipped: number
  /** Live memories the backfill would still select (same rule as selectUnscored). */
  remaining: number
  startedAt: string | null
  /** remaining ÷ the average rows/min scored since `startedAt`; null unless running with data. */
  etaMinutes: number | null
  lastError: string | null
}

/**
 * The last run's problem, for the Settings card. Process memory, not the DB: it describes the
 * running server's most recent attempt, is cleared by a clean run, and a restart (which also
 * resets the shared limiters and breakers) starts it fresh.
 */
let lastError: string | null = null

function publishBackfill() {
  publishChange({ resource: 'memoryBackfill', action: 'updated', id: MEMORY_BACKFILL_KEY })
}

/**
 * Flip the switch from the control API. A repeat of the current state is a no-op — re-pressing
 * Start must not re-stamp `startedAt`, which anchors the ETA. Publishes `memoryBackfill` on a change.
 */
export async function setBackfillSwitch(state: 'running' | 'off'): Promise<BackfillSetting> {
  const current = await getBackfillSetting()
  if (current.state === state) return current
  const next = await setBackfillState(state)
  publishBackfill()
  return next
}

/**
 * One backfill run. A no-op unless the switch is `running`. Otherwise scores up to `limit` live
 * memories missing a part (unreviewed first, then oldest) and publishes `memoryBackfill`; when
 * selection comes back empty, flips the switch to `done`.
 *
 * `onlyIds` / `deps` are test seams (shared dev DB; no real Jev or model calls in tests).
 */
export async function runBackfillBatch(
  opts: { limit?: number, onlyIds?: string[], deps?: ScoreDeps } = {}
): Promise<{ processed: number, done: boolean }> {
  const setting = await getBackfillSetting()
  if (setting.state !== 'running') return { processed: 0, done: setting.state === 'done' }

  try {
    const cfg = await resolveJevCfg(opts.deps)
    const ids = await selectUnscored(opts.limit ?? BACKFILL_BATCH, {
      onlyIds: opts.onlyIds, unreviewedOnly: false, jevConfigured: cfg !== null
    })

    if (!ids.length) {
      lastError = null
      // Tony may have paused while we selected; never turn a pause into `done`.
      if ((await getBackfillSetting()).state === 'running') {
        await setBackfillState('done')
        publishBackfill()
      }
      return { processed: 0, done: true }
    }

    const results = await scoreMemories(ids, { ...opts.deps, cfg })
    const down = [
      results.some(r => r.jev === 'unavailable') && 'Jev',
      results.some(r => r.audit === 'unavailable') && 'the audit model chain'
    ].filter(Boolean)
    lastError = down.length
      ? `${new Date().toISOString()}: ${down.join(' and ')} unavailable — those rows retry on the next run`
      : null
    publishBackfill()
    return { processed: ids.length, done: false }
  } catch (err) {
    lastError = `${new Date().toISOString()}: ${(err as Error).message ?? String(err)}`
    publishBackfill()
    throw err
  }
}

/**
 * Progress over live memories (scoped by `onlyIds` in tests). `deps.cfg` / `now` are test seams:
 * whether Jev is configured decides whether a missing Jev score counts as remaining, exactly as
 * it does for selection.
 */
export async function backfillProgress(
  opts: { onlyIds?: string[], deps?: ScoreDeps, now?: Date } = {}
): Promise<BackfillProgress> {
  const setting = await getBackfillSetting()
  const jevConfigured = (await resolveJevCfg(opts.deps)) !== null
  const startedAt = setting.startedAt ? new Date(setting.startedAt) : null

  const jevMissing = isNull(memories.jevScoredAt)
  const auditMissing = sql`${memories.auditPromptVersion} is distinct from ${AUDIT_PROMPT_VERSION}`
  const needsJev = and(jevMissing, lt(memories.jevFailures, MAX_FAILURES))
  const needsAudit = and(auditMissing, lt(memories.auditFailures, MAX_FAILURES))
  const where = (pred: SQL | undefined) => sql`count(*) filter (where ${pred ?? sql`true`})`.mapWith(Number)

  const scope = opts.onlyIds ? (opts.onlyIds.length ? inArray(memories.id, opts.onlyIds) : sql`false`) : undefined
  const [row] = await useDb().select({
    total: count(),
    jevDone: where(isNotNull(memories.jevScoredAt)),
    auditDone: where(sql`${memories.auditPromptVersion} = ${AUDIT_PROMPT_VERSION}`),
    skipped: where(or(
      and(jevMissing, gte(memories.jevFailures, MAX_FAILURES)),
      and(auditMissing, gte(memories.auditFailures, MAX_FAILURES))
    )),
    remaining: where(jevConfigured ? or(needsJev, needsAudit) : needsAudit),
    scoredSinceStart: startedAt
      ? where(or(gte(memories.jevScoredAt, startedAt), gte(memories.auditedAt, startedAt)))
      : sql`0`.mapWith(Number)
  })
    .from(memories)
    .where(and(isNull(memories.archivedAt), scope))

  const r = row!
  return {
    state: setting.state,
    total: r.total,
    jevDone: r.jevDone,
    auditDone: r.auditDone,
    skipped: r.skipped,
    remaining: r.remaining,
    startedAt: setting.startedAt,
    etaMinutes: eta(setting.state, startedAt, r.scoredSinceStart, r.remaining, opts.now ?? new Date()),
    lastError
  }
}

function eta(state: BackfillSetting['state'], startedAt: Date | null, scored: number, remaining: number, now: Date): number | null {
  if (state !== 'running' || !startedAt) return null
  if (remaining === 0) return 0
  const minutes = (now.getTime() - startedAt.getTime()) / 60_000
  if (scored <= 0 || minutes <= 0) return null
  return Math.ceil(remaining / (scored / minutes))
}
