// server/lib/ai/registry/types.ts
// Shared contracts for the AI config registry. The persisted document is one
// JSONB row (settings.key='ai_config'); ResolvedModel is the decrypted,
// ready-to-call shape the resolver hands to consumers.

export const USAGES = ['reasoning', 'bulk', 'embeddings', 'vision', 'stt', 'tts', 'rerank'] as const
export type Usage = (typeof USAGES)[number]

export const EMBEDDING_DIM = 2560

export type ProviderKind = 'anthropic' | 'openai-compatible'

export interface ProviderDef {
  id: string
  name: string
  kind: ProviderKind
  baseURL: string | null      // required for openai-compatible; null for anthropic
  apiKeyEnc: string | null    // AES-GCM ciphertext; server-only, never serialized to client
}

export interface ModelDef {
  id: string
  providerId: string
  modelId: string             // literal string sent to the API
  label: string
  dim: number | null          // EMBEDDING_DIM for embedding models, else null
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
}

export function emptyAssignments(): Assignments {
  return { reasoning: [], bulk: [], embeddings: [], vision: [], stt: [], tts: [], rerank: [] }
}

export function emptyDoc(): AiConfigDoc {
  return { version: 1, providers: [], models: [], assignments: emptyAssignments() }
}
