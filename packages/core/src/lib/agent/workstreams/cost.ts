// Cycle 81: a workstream step's cost in USD, best effort. The model a step ran on is a registry
// model def; its `modelId` is looked up in model_prices (LiteLLM's price map, mirrored by the web's
// sync-model-prices task) exactly, then without a `provider/` prefix. A model with no price row (a
// local model on the rig, or one the sync has not seen yet) costs 0 — never a guess.
import { inArray } from 'drizzle-orm'
import { useDb } from '../../../db'
import { modelPrices } from '../../../db/schema'
import { loadConfig } from '../../ai/registry/store'

interface Rates { input: number; output: number }
const TTL_MS = 60 * 60 * 1000
const cache = new Map<string, { rates: Rates | null; at: number }>()

async function ratesFor(modelDefId: string): Promise<Rates | null> {
  const hit = cache.get(modelDefId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rates
  let rates: Rates | null = null
  try {
    const def = (await loadConfig()).models.find(m => m.id === modelDefId)
    if (def) {
      const names = [...new Set([def.modelId, def.modelId.slice(def.modelId.lastIndexOf('/') + 1)])]
      const rows = await useDb().select().from(modelPrices).where(inArray(modelPrices.model, names))
      const row = rows.find(r => r.model === def.modelId) ?? rows[0]
      if (row) rates = { input: Number(row.inputCostPerToken), output: Number(row.outputCostPerToken) }
    }
  } catch (err) {
    console.warn('[workstreams] price lookup failed:', err instanceof Error ? err.message : err)
  }
  cache.set(modelDefId, { rates, at: Date.now() })
  return rates
}

export async function stepCostUsd(u: { inputTokens?: number; outputTokens?: number; modelDefId?: string }): Promise<number> {
  if (!u.modelDefId) return 0
  const r = await ratesFor(u.modelDefId)
  if (!r) return 0
  const c = (u.inputTokens ?? 0) * r.input + (u.outputTokens ?? 0) * r.output
  return Number.isFinite(c) ? c : 0
}

/** Test seam. */
export function _clearPriceCache(): void { cache.clear() }
