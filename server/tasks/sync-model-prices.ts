import { sql } from 'drizzle-orm'
import { useDb } from '../db'
import { modelPrices, messages } from '../db/schema'
import { extractRates, PRICE_MAP_URL } from '../lib/analytics/prices'

export default defineTask({
  meta: { name: 'sync-model-prices', description: 'Mirror LiteLLM token rates for models we have used' },
  async run() {
    const db = useDb()
    // Only the models we actually see — no reason to store rates for thousands we never call.
    const seen = await db.selectDistinct({ model: messages.model }).from(messages)
    const models = seen.map(r => r.model).filter((m): m is string => !!m)
    if (models.length === 0) return { result: { upserted: 0, models: 0, unpriced: 0 } }

    // raw.githubusercontent.com serves .json files as `text/plain`, not `application/json` — ofetch
    // only auto-parses JSON when the content-type says so, so without an explicit responseType this
    // silently comes back as a raw string (and every model then "misses" the map). Force JSON parsing.
    const map = await $fetch<Record<string, unknown>>(PRICE_MAP_URL, { timeout: 20_000, responseType: 'json' })
    // responseType: 'json' is necessary but not sufficient: ofetch's JSON path delegates to `destr`,
    // which in non-strict mode swallows a parse failure and hands back the original string instead of
    // throwing. A non-JSON 200 (GitHub outage page, rate-limit interstitial, truncated body) would
    // otherwise sail through here as `map`, `extractRates` would match nothing, and every model would
    // silently read as unpriced. Fail loud instead — this runs on a cron, so a thrown error just means
    // tonight's run is visible and retried tomorrow, which beats a quiet zero-price dashboard.
    if (typeof map !== 'object' || map === null || Array.isArray(map)) {
      throw new Error(`Price map fetch returned ${typeof map}, not an object — upstream may be serving an error page`)
    }
    const rows = extractRates(map, models)
    if (rows.length === 0) return { result: { upserted: 0, models: models.length, unpriced: models.length } }

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
    // Unpriced models are expected (e.g. '<synthetic>') — report, don't fail.
    return { result: { upserted: rows.length, models: models.length, unpriced: models.length - rows.length } }
  }
})
