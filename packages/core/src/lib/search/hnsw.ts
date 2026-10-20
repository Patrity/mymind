// HNSW session knobs for the vector lanes (2026-10-19 stack review, R3 §6).
//
// pgvector's `hnsw.ef_search` defaults to 40, and an HNSW scan returns at most ef_search
// candidates — so every lane here that did `ORDER BY embedding <=> $q LIMIT 50` could only ever
// get ~40 rows back, and a lane with a WHERE filter (scope / project / session) got fewer still,
// because the post-filter runs on those same ≤40 candidates. Both are session GUCs, so the fix is
// a transaction per lane with `SET LOCAL` — nothing leaks to the next query on that pooled client.
//
// `hnsw.iterative_scan` (pgvector >= 0.8) is what makes a FILTERED scan keep walking the graph
// until it has LIMIT rows. Setting an unknown GUC under the reserved `hnsw.` prefix is an ERROR on
// older pgvector and would abort the lane's transaction, so it is gated on a one-time version probe.
import { sql, type SQL } from 'drizzle-orm'

/** The slice of a drizzle handle this module needs — kept narrow so tests can fake it. `Tx` is
 *  whatever the handle's `transaction` yields (a real PgTransaction in production), so the lane
 *  keeps the full query builder on the tx it is handed. */
export interface HnswTx { execute(q: SQL): Promise<unknown> }
export interface HnswDb<Tx extends HnswTx = HnswTx> extends HnswTx {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
}

export interface HnswSessionOpts {
  /** The lane's `LIMIT`. ef_search is raised to at least twice this. */
  limit: number
  /** True when the lane has a caller-supplied WHERE (scope/project/session) beyond the table's
   *  own liveness predicate — the case where iterative scan earns its keep. */
  filtered: boolean
  /** `SearchRelevanceConfig.hnswEfSearchMin` */
  efSearchMin: number
  /** `SearchRelevanceConfig.hnswIterativeScan` */
  iterativeScan: boolean
}

/** pgvector rejects ef_search outside [1, 1000]. */
export const HNSW_EF_SEARCH_MAX = 1000
export const PGVECTOR_ITERATIVE_SCAN_MIN = [0, 8, 0] as const

export function efSearchFor(limit: number, min: number): number {
  const want = Math.max(Math.floor(min), 2 * Math.floor(limit))
  return Math.min(HNSW_EF_SEARCH_MAX, Math.max(1, want))
}

/** `'0.10.0' >= '0.8.0'` numerically, not lexically. Non-numeric parts count as 0. */
export function versionAtLeast(version: string, min: readonly [number, number, number]): boolean {
  const parts = version.split('.').map(p => parseInt(p, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const have = parts[i] ?? 0
    if (have > min[i]!) return true
    if (have < min[i]!) return false
  }
  return true
}

let capability: Promise<boolean> | null = null

/** One `pg_extension` probe per process. A failed probe, or no `vector` row, reads as "not
 *  supported" — the lane then runs with ef_search only, exactly as it would on pgvector 0.7. */
export function pgvectorSupportsIterativeScan(db: HnswDb): Promise<boolean> {
  if (!capability) {
    capability = (async () => {
      try {
        const res = await db.execute(sql`select extversion from pg_extension where extname = 'vector'`) as { rows?: Array<{ extversion?: unknown }> }
        const v = res?.rows?.[0]?.extversion
        return typeof v === 'string' && versionAtLeast(v, PGVECTOR_ITERATIVE_SCAN_MIN)
      } catch {
        return false
      }
    })()
  }
  return capability
}

export function _resetHnswCapabilityForTests(): void {
  capability = null
}

/**
 * Run `fn(tx)` inside a transaction whose HNSW GUCs are set for this lane. The lane's query MUST
 * use the `tx` it is handed — `SET LOCAL` is per connection, and a query on the pool's `db` could
 * land on a different client.
 */
export async function withHnswSession<T, Tx extends HnswTx = HnswTx>(db: HnswDb<Tx>, opts: HnswSessionOpts, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const ef = efSearchFor(opts.limit, opts.efSearchMin)
  const iterative = opts.filtered && opts.iterativeScan && await pgvectorSupportsIterativeScan(db)
  return db.transaction(async (tx) => {
    // SET cannot take a bind parameter; ef is an integer we computed, so sql.raw is safe here.
    await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${ef}`))
    if (iterative) await tx.execute(sql.raw(`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`))
    return fn(tx)
  })
}
