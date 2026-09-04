import { sql } from 'drizzle-orm'
import { useDb } from '../../db'

/** Settings key holding the price-sync trigger's state. */
export const SYNC_STATE_KEY = 'model_price_sync'

export type PriceSyncState = {
  /**
   * Every model we have already looked up in the upstream map — priced or not.
   *
   * Deliberately "attempted", not "priced": `<synthetic>` and anything else missing upstream
   * can never gain a `model_prices` row, so keying the trigger off the price table would make
   * the task fetch on every tick forever. This set is what makes frequent scheduling safe.
   */
  attempted: string[]
  lastFullSyncAt: Date | null
}

/** Zero state (no sync has run) reads as "nothing attempted, never synced" — i.e. stale. */
export async function readSyncState(): Promise<PriceSyncState> {
  const db = useDb()
  const rows = await db.execute(sql`select value from settings where key = ${SYNC_STATE_KEY}`)
  const v = (rows.rows[0] as { value?: unknown } | undefined)?.value as
    | { attempted?: unknown, lastFullSyncAt?: unknown }
    | undefined
  if (!v || typeof v !== 'object') return { attempted: [], lastFullSyncAt: null }
  const attempted = Array.isArray(v.attempted) ? v.attempted.filter((m): m is string => typeof m === 'string') : []
  const ts = typeof v.lastFullSyncAt === 'string' ? new Date(v.lastFullSyncAt) : null
  return { attempted, lastFullSyncAt: ts && !Number.isNaN(ts.getTime()) ? ts : null }
}

export async function writeSyncState(state: { attempted: string[], lastFullSyncAt: Date }): Promise<void> {
  const db = useDb()
  const value = JSON.stringify({
    attempted: state.attempted,
    lastFullSyncAt: state.lastFullSyncAt.toISOString()
  })
  await db.execute(sql`
    insert into settings (key, value) values (${SYNC_STATE_KEY}, ${value}::jsonb)
    on conflict (key) do update set value = excluded.value, updated_at = now()`)
}

/**
 * Distinct models seen since `since` — the cheap probe the frequent schedule depends on.
 *
 * Bounded by `created_at` so it rides `messages_created_at_idx` instead of seq-scanning the
 * whole table (~945 MB on the live box). `null` means no bound, which IS a full scan and is
 * only used on a cold start / full refresh, where we need every model ever seen anyway.
 */
export async function recentModelsSince(since: Date | null): Promise<string[]> {
  const db = useDb()
  const bound = since ? sql`and created_at >= ${since.toISOString()}` : sql``
  const rows = await db.execute(sql`
    select distinct model from messages where model is not null ${bound}`)
  return (rows.rows as { model: string }[]).map(r => r.model)
}
