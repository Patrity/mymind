// Client-side mirror of the embedding vector dimension. The server source of
// truth is server/lib/ai/registry/types.ts (server-only); this is the single
// client constant so components don't hardcode the literal. Auto-imported.
export const EMBEDDING_DIM = 2560

// Cycle 83 pools: mirrors DEFAULT_MAX_IN_FLIGHT and MAX_IN_FLIGHT_LIMITS.max in
// packages/core/src/lib/ai/registry/types.ts (test/ai-subagents.test.ts keeps them in step).
export const DEFAULT_MAX_IN_FLIGHT = 6
export const MAX_IN_FLIGHT_MAX = 256
