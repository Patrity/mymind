import { sql } from 'drizzle-orm'
import { useDb } from '../db'
import { litellmDaily } from '../db/schema'
import { promInstant } from '../lib/analytics/prom'
import { loadAnalyticsConfig } from '../lib/analytics/store'

/** Yesterday, UTC, as YYYY-MM-DD — the day a post-midnight run summarises. */
function yesterdayUtc(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

const byModel = (rows: { metric: Record<string, string>, value: [number, string] }[]) => {
  const m = new Map<string, number>()
  for (const r of rows) {
    const model = r.metric.model
    if (!model) continue
    const v = Number(r.value[1])
    if (Number.isFinite(v)) m.set(model, v)
  }
  return m
}

// Explicit result shape: defineTask infers its generic from `run`'s return type, and without an
// annotation TypeScript locks that generic to whichever branch it sees first, then rejects the
// other early-return branches for having a differently-shaped optional-key set. Naming the shape
// once (all extra fields optional) fixes the inference without changing any returned values.
interface RollupResult {
  day: string
  models: number
  unreachable?: string
  note?: string
}

export default defineTask({
  meta: { name: 'rollup-litellm-daily', description: 'Persist a daily rollup of LiteLLM traffic' },
  async run(): Promise<{ result: RollupResult }> {
    const day = yesterdayUtc()
    const cfg = await loadAnalyticsConfig() // never null; may carry an empty prometheusUrl
    if (!cfg.prometheusUrl) return { result: { day, models: 0, unreachable: 'no prometheusUrl configured' } }

    // A metrics rollup must NEVER take the app down: an unreachable Prometheus is a recorded
    // non-event, not a throw.
    let tokens, spend, requests
    try {
      [tokens, spend, requests] = await Promise.all([
        promInstant(cfg.prometheusUrl, `sum by (model) (increase(litellm_total_tokens[24h]))`),
        promInstant(cfg.prometheusUrl, `sum by (model) (increase(litellm_total_spend[24h]))`),
        promInstant(cfg.prometheusUrl, `sum by (model) (increase(litellm_requests_total[24h]))`)
      ])
    } catch (e) {
      return { result: { day, models: 0, unreachable: (e as Error).message } }
    }

    const t = byModel(tokens), s = byModel(spend), q = byModel(requests)
    const models = [...new Set([...t.keys(), ...s.keys(), ...q.keys()])]
    if (models.length === 0) return { result: { day, models: 0, note: 'no litellm series for this window' } }

    const rows = models.map(model => ({
      day,
      model,
      tokens: Math.round(t.get(model) ?? 0),
      spend: String(s.get(model) ?? 0),
      requests: Math.round(q.get(model) ?? 0)
    }))

    // Idempotent: re-running the same day overwrites rather than duplicating.
    await useDb().insert(litellmDaily).values(rows).onConflictDoUpdate({
      target: [litellmDaily.day, litellmDaily.model],
      set: {
        tokens: sql`excluded.tokens`,
        spend: sql`excluded.spend`,
        requests: sql`excluded.requests`
      }
    })

    return { result: { day, models: models.length } }
  }
})
