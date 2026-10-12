// server/lib/ai/registry/types.ts
// Shared contracts for the AI config registry. The persisted document is one
// JSONB row (settings.key='ai_config'); ResolvedModel is the decrypted,
// ready-to-call shape the resolver hands to consumers.

// `jev` is TypeSafe System One — a decision model, not a chat completion. It is in this list
// anyway because everything a caller needs (baseURL, apiKey, pinned model id) is exactly what
// a ProviderDef + ModelDef already carry, and the whole registry — zod schema, PUT validation,
// and the Settings assignments UI — is generated from this array. Keeping Jev's credential in
// an env file instead would have made it the one model secret not editable from Settings.
//
// `subagents` (cycle 83) is the ordered, capability-described list a coordinator picks child
// workstream models from, by label (resolveSubagentModel). Empty → children run on `reasoning`.
export const USAGES = ['reasoning', 'bulk', 'embeddings', 'vision', 'stt', 'tts', 'rerank', 'jev', 'subagents'] as const
export type Usage = (typeof USAGES)[number]

export const EMBEDDING_DIM = 2560

/** Workstream segments allowed to run at once against one model when its `maxInFlight` is unset
 *  (cycle 83 pools). Set from the vLLM ramp (scripts/vllm-ramp.ts, 2026-10-11, dev reasoning model
 *  via LiteLLM): up to 8 concurrent streams TTFT p95 stayed under 1 s and aggregate throughput
 *  peaked (~370 tok/s); from 10 on, p95 jumped to 4.5–5.5 s (requests queue for a server slot) with
 *  no aggregate gain. The knee is 8–10, so the default is 8. */
export const DEFAULT_MAX_IN_FLIGHT = 8
/** Bounds for ModelDef.maxInFlight. */
export const MAX_IN_FLIGHT_LIMITS = { min: 1, max: 256 } as const

// Every provider is OpenAI-compatible — non-OpenAI vendors are fronted by an
// OpenAI-compatible gateway (LiteLLM). Kept as a union for forward-compatibility.
export type ProviderKind = 'openai-compatible'

export interface ProviderDef {
  id: string
  name: string
  kind: ProviderKind
  baseURL: string | null      // required (the provider/gateway endpoint)
  apiKeyEnc: string | null    // AES-GCM ciphertext; server-only, never serialized to client
}

export interface ModelDef {
  id: string
  providerId: string
  modelId: string             // literal string sent to the API
  label: string
  dim: number | null          // EMBEDDING_DIM for embedding models, else null
  contextWindow: number | null // max input tokens; null = unknown (the /agent context meter then shows a count only)
  /** Written for the coordinator choosing a child's model ("fast, long context: research, reading"). */
  description: string | null
  /** Workstream segments running at once against this model (its pool); null = DEFAULT_MAX_IN_FLIGHT. */
  maxInFlight: number | null
}

export type Assignments = Record<Usage, string[]>  // usage -> ordered model ids (failover priority)

export interface AiConfigDoc {
  version: 1
  providers: ProviderDef[]
  models: ModelDef[]
  assignments: Assignments
}

// A model resolved for use: provider + model merged, key decrypted.
export interface ResolvedModel {
  usage: Usage
  modelDefId: string
  providerKind: ProviderKind
  baseURL: string | null
  apiKey: string | null
  modelId: string
  label: string
  dim: number | null
  contextWindow: number | null // max input tokens; null = unknown (the /agent context meter then shows a count only)
}

export function emptyAssignments(): Assignments {
  return { reasoning: [], bulk: [], embeddings: [], vision: [], stt: [], tts: [], rerank: [], jev: [], subagents: [] }
}

export function emptyDoc(): AiConfigDoc {
  return { version: 1, providers: [], models: [], assignments: emptyAssignments() }
}
