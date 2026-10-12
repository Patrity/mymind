// server/lib/ai/registry/schema.ts
// Zod schema for the AI config document + referential integrity (no FKs since
// it's one JSONB doc) + a client-safe redaction that strips key ciphertext.
import { z } from 'zod'
import { MAX_IN_FLIGHT_LIMITS, USAGES, type AiConfigDoc, type Usage } from './types'

const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['openai-compatible']),
  baseURL: z.string().url().nullable(),
  apiKeyEnc: z.string().nullable()
})

/** Cycle 83 fields, shared by the stored doc and the PUT body. Defaulted to null, so a config
 *  (or an older client's PUT) written before they existed still parses. */
export const modelDescriptionSchema = z.string().trim().max(500).nullable().default(null)
  .transform(v => (v ? v : null))
export const maxInFlightSchema = z.number().int().min(MAX_IN_FLIGHT_LIMITS.min).max(MAX_IN_FLIGHT_LIMITS.max).nullable().default(null)

const modelSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  label: z.string().min(1),
  dim: z.number().int().positive().nullable(),
  contextWindow: z.number().int().positive().nullable().default(null),
  description: modelDescriptionSchema,
  maxInFlight: maxInFlightSchema
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

/**
 * What a SAVE of `subagents` must satisfy, beyond referential integrity (cycle 83 fix round 1):
 *   - labels are unique within the list — the coordinator picks a child's model BY LABEL, so a
 *     second model under the same label could never be chosen (M1);
 *   - no embedding models (dim set) — they cannot run an agent turn (M2).
 * Checked by the PUT only, deliberately NOT in parseConfig: a stored doc that fails to parse
 * reads as "AI not configured" everywhere, so a rule added later must never be able to make an
 * existing config unreadable. Returns readable problems; empty = fine.
 */
export function subagentsProblems(doc: AiConfigDoc): string[] {
  const problems: string[] = []
  const seen = new Map<string, number>()
  for (const id of doc.assignments.subagents ?? []) {
    const m = doc.models.find(x => x.id === id)
    if (!m) continue
    if (m.dim !== null) problems.push(`"${m.label}" is an embedding model and cannot be a subagents model`)
    seen.set(m.label, (seen.get(m.label) ?? 0) + 1)
  }
  for (const [label, n] of seen) {
    if (n > 1) problems.push(`subagents has ${n} models labelled "${label}" — the coordinator picks by label, so labels there must be unique`)
  }
  return problems
}

/** Cycle 84: `judge` may not list an embedding model (it cannot answer the judge's prompt). PUT-only,
 *  like subagentsProblems — never in parseConfig. Empty = fine. */
export function judgeProblems(doc: AiConfigDoc): string[] {
  return (doc.assignments.judge ?? []).flatMap((id) => {
    const m = doc.models.find(x => x.id === id)
    return m && m.dim !== null ? [`"${m.label}" is an embedding model and cannot be a judge model`] : []
  })
}

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
