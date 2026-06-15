import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'
import { DEFAULT_CONFIG, type ObservabilityConfig } from './types'
import { ACTIVITY_KINDS } from '../../../shared/types/activity'

const KEY = 'observability_config'

const captureSchema = z.object(
  Object.fromEntries(ACTIVITY_KINDS.map(k => [k, z.boolean().default(true)]))
).default(DEFAULT_CONFIG.capture)

const schema = z.object({
  version: z.literal(1),
  retainInfoDays: z.number().int().positive().default(DEFAULT_CONFIG.retainInfoDays),
  retainErrorDays: z.number().int().positive().default(DEFAULT_CONFIG.retainErrorDays),
  maxRows: z.number().int().positive().default(DEFAULT_CONFIG.maxRows),
  capture: captureSchema,
  alerts: z.object({
    badge: z.boolean().default(true),
    toast: z.boolean().default(true),
    email: z.object({
      enabled: z.boolean().default(false),
      recipient: z.string().email().nullable().default(null),
      from: z.string().email().nullable().default(null),
      apiKeyEnc: z.string().nullable().default(null),
      minSeverity: z.enum(['warn', 'error']).default('error'),
      digestWindowMin: z.number().int().positive().default(15)
    }).default(DEFAULT_CONFIG.alerts.email)
  }).default(DEFAULT_CONFIG.alerts)
})

export function parseObsConfig(input: unknown): ObservabilityConfig {
  return schema.parse(input) as ObservabilityConfig
}

export interface RedactedObsConfig extends Omit<ObservabilityConfig, 'alerts'> {
  alerts: Omit<ObservabilityConfig['alerts'], 'email'> & {
    email: Omit<ObservabilityConfig['alerts']['email'], 'apiKeyEnc'> & { hasKey: boolean }
  }
}

export function redactObsConfig(doc: ObservabilityConfig): RedactedObsConfig {
  const { apiKeyEnc, ...email } = doc.alerts.email
  return { ...doc, alerts: { ...doc.alerts, email: { ...email, hasKey: apiKeyEnc !== null } } }
}

let cache: ObservabilityConfig | null = null

export async function loadObsConfig(): Promise<ObservabilityConfig> {
  if (cache) return cache
  const db = useDb()
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1)
  cache = row ? parseObsConfig(row.value) : DEFAULT_CONFIG
  return cache
}

export async function saveObsConfig(doc: ObservabilityConfig): Promise<void> {
  const validated = parseObsConfig(doc)
  const db = useDb()
  await db.insert(settings)
    .values({ key: KEY, value: validated, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: validated, updatedAt: new Date() } })
  cache = validated
}

export function invalidateObsConfig(): void { cache = null }
