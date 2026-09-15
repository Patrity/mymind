// server/lib/analytics/store.ts
// Thin DB I/O for the single analytics_config JSONB row + an in-process cache.
// Mirrors server/lib/imagegen/store.ts / server/lib/search/store.ts.
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'
import { encryptSecret } from '../ai/registry/crypto'
import type { AnalyticsConfig } from './types'
import { defaultRigServices } from './catalog'

const KEY = 'analytics_config'
let cache: AnalyticsConfig | null = null

export function defaultAnalyticsConfig(): AnalyticsConfig {
  return {
    prometheusUrl: 'http://192.168.2.90:9090',
    litellmUrl: 'http://192.168.2.85:4000',
    gpuLabels: {
      '24d1cd2c-76e0-8a7a-66be-48dc43b0e4ac': 'Strix A',
      '875c12f4-d03b-89ac-528d-57d15bee97bb': 'Strix B',
      '2035bb42-d953-83d3-eb4f-5cb8214873dd': 'Zotac (voice/util)',
      '0cbf708d-6235-18d7-8bd2-eaeea0389254': 'PNY (Image Gen)',
      'b2c1087a-14f3-4f32-7815-d1745391c990': 'PRO 6000 (LLM)'
    },
    rigHost: '192.168.2.25',
    services: defaultRigServices()
  }
}


// The two catalogs merge differently, on purpose.
//
// gpuLabels merges PER KEY. A shallow spread meant a stored row replaced the defaults
// entirely, so a newly installed card stayed unlabelled in production until someone
// hand-edited the row. A stored label still wins for any uuid it defines, and a default
// for an absent uuid is inert because resolveGpuLabel only runs for uuids Prometheus is
// currently reporting.
//
// services replaces WHOLESALE once a row exists. Deleting a service has to mean something:
// an entry left behind for a retired service keeps getting health-checked and reports DOWN,
// which is exactly how the stopped coder pinned the public strip to amber. A per-id merge
// would make defaults undeletable and reintroduce that.
export function mergeAnalyticsConfig(raw: Partial<AnalyticsConfig> | null | undefined): AnalyticsConfig {
  const defaults = defaultAnalyticsConfig()
  return {
    ...defaults,
    ...(raw ?? {}),
    gpuLabels: { ...defaults.gpuLabels, ...(raw?.gpuLabels ?? {}) },
    services: raw?.services ?? defaults.services
  }
}

// Empty-string master key -> undefined ("no change"); non-empty is the new plaintext key.
const masterKeySchema = z.preprocess(
  v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).optional()
)

// A service must carry the matcher its source actually uses, or it would silently never
// match and sit on the strip as a permanent "unknown".
const rigServiceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  source: z.enum(['up', 'probes']),
  job: z.string().min(1).optional(),
  probeService: z.string().min(1).optional(),
  port: z.string().regex(/^\d+$/).optional(),
  instanceContains: z.string().min(1).optional(),
  public: z.boolean()
}).refine(
  s => s.source === 'up' ? !!s.job : !!(s.probeService || s.port || s.instanceContains),
  { message: 'an "up" service needs a job; a "probes" service needs probeService, port or instanceContains' }
)

export const analyticsConfigInputSchema = z.object({
  prometheusUrl: z.string().url().optional(),
  litellmUrl: z.string().url().optional(),
  litellmMasterKey: masterKeySchema,
  gpuLabels: z.record(z.string(), z.string()).optional(),
  rigHost: z.string().min(1).optional(),
  services: z.array(rigServiceSchema).optional()
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
    gpuLabels: input.gpuLabels ?? current.gpuLabels,
    rigHost: input.rigHost ?? current.rigHost,
    services: input.services ?? current.services
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
