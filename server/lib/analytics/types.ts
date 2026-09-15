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
  /** The rig host probe targets live on, used to build the probe instance regex. */
  rigHost: string
  /** The health-strip catalog. Declarative so it can be edited without a deploy. */
  services: RigServiceDef[]
}

/**
 * One entry in the health strip. `source` picks which Prometheus vector it is matched
 * against, and exactly one of the matchers below identifies it within that vector:
 *   up     -> `job`
 *   probes -> `probeService` (the blackbox target's `service` label), with `port` as a
 *             fallback for targets predating that label, or `instanceContains` for a
 *             probe that does not live on the rig host.
 */
export interface RigServiceDef {
  id: string
  label: string
  source: 'up' | 'probes'
  job?: string
  probeService?: string
  port?: string
  instanceContains?: string
  /** Published on the unauthenticated /api/public/rig strip. Plumbing stays private. */
  public: boolean
}
