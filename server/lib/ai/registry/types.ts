// server/lib/ai/registry/types.ts
// Shared contracts for the AI config registry. The persisted document is one
// JSONB row (settings.key='ai_config'); ResolvedModel is the decrypted,
// ready-to-call shape the resolver hands to consumers.

// `jev` is TypeSafe System One — a decision model, not a chat completion. It is in this list
// anyway because everything a caller needs (baseURL, apiKey, pinned model id) is exactly what
// a ProviderDef + ModelDef already carry, and the whole registry — zod schema, PUT validation,
// and the Settings assignments UI — is generated from this array. Keeping Jev's credential in
// an env file instead would have made it the one model secret not editable from Settings.
export const USAGES = ['reasoning', 'bulk', 'embeddings', 'vision', 'stt', 'tts', 'rerank', 'jev'] as const
export type Usage = (typeof USAGES)[number]

export const EMBEDDING_DIM = 2560

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
  return { reasoning: [], bulk: [], embeddings: [], vision: [], stt: [], tts: [], rerank: [], jev: [] }
}

export function emptyDoc(): AiConfigDoc {
  return { version: 1, providers: [], models: [], assignments: emptyAssignments() }
}
