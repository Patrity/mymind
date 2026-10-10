// server/lib/ai/registry/schema.ts
// Zod schema for the AI config document + referential integrity (no FKs since
// it's one JSONB doc) + a client-safe redaction that strips key ciphertext.
import { z } from 'zod'
import { USAGES, type AiConfigDoc, type Usage } from './types'

const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['openai-compatible']),
  baseURL: z.string().url().nullable(),
  apiKeyEnc: z.string().nullable()
})

const modelSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  label: z.string().min(1),
  dim: z.number().int().positive().nullable(),
  contextWindow: z.number().int().positive().nullable().default(null)
})

/**
 * Every usage DEFAULTS to empty rather than being required.
 *
 * Without the default, adding a usage to USAGES makes the schema reject every config stored
 * before it existed — and a parse failure here surfaces as "AI not configured", so the whole
 * provider/model set appears to vanish and the app redirects to onboarding. Adding `jev`
 * reproduced exactly that against a real config.
 *
 * A usage nobody has assigned is legitimately empty, so defaulting is also the honest
 * reading: absent and empty mean the same thing here.
 */
const assignmentsSchema = z.object(
  Object.fromEntries(USAGES.map(u => [u, z.array(z.string()).default([])])) as Record<Usage, z.ZodDefault<z.ZodArray<z.ZodString>>>
)

const docSchema = z.object({
  version: z.literal(1),
  providers: z.array(providerSchema),
  models: z.array(modelSchema),
  assignments: assignmentsSchema
}).superRefine((d, ctx) => {
  const providerIds = new Set(d.providers.map(p => p.id))
  const modelIds = new Set(d.models.map(m => m.id))
  for (const p of d.providers) {
    if (p.kind === 'openai-compatible' && !p.baseURL) {
      ctx.addIssue({ code: 'custom', message: `provider "${p.name}" (openai-compatible) requires a baseURL`, path: ['providers'] })
    }
  }
  for (const m of d.models) {
    if (!providerIds.has(m.providerId)) {
      ctx.addIssue({ code: 'custom', message: `model "${m.label}" references missing provider ${m.providerId}`, path: ['models'] })
    }
  }
  for (const u of USAGES) {
    for (const id of d.assignments[u]) {
      if (!modelIds.has(id)) {
        ctx.addIssue({ code: 'custom', message: `assignment "${u}" references missing model ${id}`, path: ['assignments', u] })
      }
    }
  }
})

export function parseConfig(input: unknown): AiConfigDoc {
  return docSchema.parse(input) as AiConfigDoc
}

export interface RedactedProvider { id: string; name: string; kind: string; baseURL: string | null; hasKey: boolean }
export interface RedactedDoc { version: 1; providers: RedactedProvider[]; models: AiConfigDoc['models']; assignments: AiConfigDoc['assignments'] }

/** Client-safe view: no ciphertext ever leaves the server. */
export function redactDoc(doc: AiConfigDoc): RedactedDoc {
  return {
    version: doc.version,
    providers: doc.providers.map(p => ({ id: p.id, name: p.name, kind: p.kind, baseURL: p.baseURL, hasKey: p.apiKeyEnc !== null })),
    models: doc.models,
    assignments: doc.assignments
  }
}
