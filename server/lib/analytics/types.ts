// server/lib/analytics/types.ts
// Server-only shapes for the /analytics slice. No logic here.
// Cross-boundary DTOs (SeriesResponse, SnapshotResponse, etc.) live in
// ~~/shared/types/analytics — this file only holds the config shape that
// carries the encrypted LiteLLM key and must never reach the client.

export interface AnalyticsConfig {
  prometheusUrl: string
  litellmUrl: string
  /** AES-256-GCM blob via encryptSecret(); never leaves the server. */
  litellmMasterKeyEnc?: string
  /** GPU uuid (lowercase, no "GPU-" prefix) -> friendly label. */
  gpuLabels: Record<string, string>
}
