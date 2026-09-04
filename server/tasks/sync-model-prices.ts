import { sql } from 'drizzle-orm'
import { useDb } from '../db'
import { modelPrices } from '../db/schema'
import { decideSync, extractRates, PRICE_MAP_URL } from '../lib/analytics/prices'
import { readSyncState, writeSyncState, recentModelsSince } from '../lib/analytics/price-sync-state'

export default defineTask({
  meta: { name: 'sync-model-prices', description: 'Mirror LiteLLM token rates for models we have used' },
  async run() {
    const db = useDb()
    const now = new Date()
    const state = await readSyncState()

    // Cheap probe: only models seen since the last successful sync. Bounded by created_at so it
    // uses messages_created_at_idx rather than seq-scanning the table on every tick.
    //
    // A backfill that lands rows with OLD created_at can slip past this probe — those models get
    // picked up by the staleness path within PRICE_MAX_AGE_MS instead. Accepted: catching them
    // sooner would mean an unbounded scan every tick, which is the cost this probe exists to avoid.
    const recentModels = await recentModelsSince(state.lastFullSyncAt)
    const decision = decideSync({
      recentModels,
      attempted: state.attempted,
      lastFullSyncAt: state.lastFullSyncAt,
      now
    })
    if (!decision.sync) return { result: { skipped: true, reason: decision.reason, upserted: 0, models: 0, unpriced: 0 } }

    // Only the models we actually see — no reason to store rates for thousands we never call.
    const models = await recentModelsSince(null)
    if (models.length === 0) return { result: { skipped: false, reason: decision.reason, upserted: 0, models: 0, unpriced: 0 } }

    // raw.githubusercontent.com serves .json files as `text/plain`, not `application/json` — ofetch
    // only auto-parses JSON when the content-type says so, so without an explicit responseType this
    // silently comes back as a raw string (and every model then "misses" the map). Force JSON parsing.
    const map = await $fetch<Record<string, unknown>>(PRICE_MAP_URL, { timeout: 20_000, responseType: 'json' })
    // responseType: 'json' is necessary but not sufficient: ofetch's JSON path delegates to `destr`,
    // which in non-strict mode swallows a parse failure and hands back the original string instead of
    // throwing. A non-JSON 200 (GitHub outage page, rate-limit interstitial, truncated body) would
    // otherwise sail through here as `map`, `extractRates` would match nothing, and every model would
    // silently read as unpriced. Fail loud instead — this runs on a cron, so a thrown error just means
    // this run is visible and retried on the next tick, which beats a quiet zero-price dashboard.
    if (typeof map !== 'object' || map === null || Array.isArray(map)) {
      throw new Error(`Price map fetch returned ${typeof map}, not an object — upstream may be serving an error page`)
    }
    const rows = extractRates(map, models)

    if (rows.length > 0) {
      await db.insert(modelPrices).values(rows).onConflictDoUpdate({
        target: modelPrices.model,
        set: {
          inputCostPerToken: sql`excluded.input_cost_per_token`,
          outputCostPerToken: sql`excluded.output_cost_per_token`,
          cacheReadCostPerToken: sql`excluded.cache_read_cost_per_token`,
          cacheCreationCostPerToken: sql`excluded.cache_creation_cost_per_token`,
          cacheCreationAbove1hCostPerToken: sql`excluded.cache_creation_above_1h_cost_per_token`,
          source: sql`excluded.source`,
          fetchedAt: sql`now()`
        }
      })
    }

    // Recorded only after a successful fetch: a thrown fetch leaves `attempted` untouched, so the
    // next tick retries instead of marking an unfetched model as permanently attempted. Models that
    // ARE unpriceable land here too — that is the point, it stops them re-triggering every tick.
    await writeSyncState({ attempted: models, lastFullSyncAt: now })

    // Unpriced models are expected (e.g. '<synthetic>') — report, don't fail.
    return {
      result: {
        skipped: false, reason: decision.reason,
        upserted: rows.length, models: models.length, unpriced: models.length - rows.length
      }
    }
  }
})
