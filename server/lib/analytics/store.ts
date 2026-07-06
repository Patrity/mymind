// server/lib/analytics/store.ts
// Thin DB I/O for the single analytics_config JSONB row + an in-process cache.
// Mirrors server/lib/imagegen/store.ts / server/lib/search/store.ts.
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'
import { encryptSecret } from '../ai/registry/crypto'
import type { AnalyticsConfig } from './types'

const KEY = 'analytics_config'
let cache: AnalyticsConfig | null = null

export function defaultAnalyticsConfig(): AnalyticsConfig {
  return {
    prometheusUrl: 'http://192.168.2.90:9090',
    litellmUrl: 'http://192.168.2.85:4000',
    gpuLabels: {
      '24d1cd2c-76e0-8a7a-66be-48dc43b0e4ac': 'Coder A (Strix)',
      '875c12f4-d03b-89ac-528d-57d15bee97bb': 'Coder B (Strix)',
      '2035bb42-d953-83d3-eb4f-5cb8214873dd': 'Vision (PNY)',
      '0cbf708d-6235-18d7-8bd2-eaeea0389254': 'Zotac (voice/util)',
      'bbd65887-973e-4982-ced8-2ba8dcd3586d': 'Autocomplete (P2000)'
    }
  }
}

export function mergeAnalyticsConfig(raw: Partial<AnalyticsConfig> | null | undefined): AnalyticsConfig {
  return { ...defaultAnalyticsConfig(), ...(raw ?? {}) }
}

// Empty-string master key -> undefined ("no change"); non-empty is the new plaintext key.
const masterKeySchema = z.preprocess(
  v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).optional()
)

export const analyticsConfigInputSchema = z.object({
  prometheusUrl: z.string().url().optional(),
  litellmUrl: z.string().url().optional(),
  litellmMasterKey: masterKeySchema,
  gpuLabels: z.record(z.string(), z.string()).optional()
})
export type AnalyticsConfigInput = z.infer<typeof analyticsConfigInputSchema>

export function parseAnalyticsConfigInput(raw: unknown): AnalyticsConfigInput {
  return analyticsConfigInputSchema.parse(raw)
}

export async function loadAnalyticsConfig(): Promise<AnalyticsConfig> {
  if (cache) return cache
  const [row] = await useDb().select().from(settings).where(eq(settings.key, KEY)).limit(1)
  cache = mergeAnalyticsConfig(row?.value as Partial<AnalyticsConfig> | undefined)
  return cache
}

export async function saveAnalyticsConfig(input: AnalyticsConfigInput): Promise<AnalyticsConfig> {
  const current = await loadAnalyticsConfig()
  const next: AnalyticsConfig = {
    prometheusUrl: input.prometheusUrl ?? current.prometheusUrl,
    litellmUrl: input.litellmUrl ?? current.litellmUrl,
    litellmMasterKeyEnc: current.litellmMasterKeyEnc,
    gpuLabels: input.gpuLabels ?? current.gpuLabels
  }
  if (input.litellmMasterKey) {
    next.litellmMasterKeyEnc = encryptSecret(input.litellmMasterKey)
  }
  await useDb().insert(settings)
    .values({ key: KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
  cache = next
  return next
}

export function invalidateAnalyticsConfig(): void { cache = null }
