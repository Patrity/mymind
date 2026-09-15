import type { RigServiceDef } from './types'
import { defaultRigServices } from './catalog'
// server/lib/analytics/queries.ts
// THE named query catalog — the security boundary. Endpoints only ever execute
// PromQL defined here; the client can only name a panel id.
// Metric names verified live against the homelab exporters on 2026-07-06.

export interface RangeQueryDef {
  expr: (window: string) => string
  legend: (labels: Record<string, string>, gpuLabels: Record<string, string>) => string
}
export interface RangePanelDef { id: string, queries: RangeQueryDef[] }

// nvidia_smi_gpu_info already carries the real model name on every scrape
// ("NVIDIA RTX PRO 6000 Blackwell Workstation Edition"). Strip the vendor, retail and
// architecture noise so an unconfigured card reads "RTX PRO 6000" rather than a hex fragment.
const GPU_NAME_NOISE = /\b(NVIDIA|GeForce|Workstation Edition|Founders Edition|Laptop GPU|Blackwell|Lovelace|Ada|Ampere|Turing|Hopper)\b/gi

export function prettyGpuName(name: string | undefined | null): string | null {
  if (!name) return null
  const cleaned = name.replace(GPU_NAME_NOISE, ' ').replace(/\s+/g, ' ').trim()
  return cleaned || null
}

// Precedence: an explicit configured label, then the hardware's own name, then the uuid.
// Only the last of those is a dead end, and it should now be unreachable in practice.
export function resolveGpuLabel(uuid: string, gpuLabels: Record<string, string>, hardwareName?: string | null): string {
  return gpuLabels[uuid] ?? prettyGpuName(hardwareName) ?? `GPU ${uuid.slice(0, 8)}`
}

const gpuLegend: RangeQueryDef['legend'] = (l, g) => resolveGpuLabel(l.uuid ?? '?', g, l.name)
const modelLegend: RangeQueryDef['legend'] = l => l.model_name ?? l.model ?? '?'

export const RANGE_PANELS: Record<string, RangePanelDef> = {
  'gpu-util': { id: 'gpu-util', queries: [{ expr: () => 'nvidia_smi_utilization_gpu_ratio * 100', legend: gpuLegend }] },
  'gpu-vram': { id: 'gpu-vram', queries: [{ expr: () => 'nvidia_smi_memory_used_bytes', legend: gpuLegend }] },
  'gpu-power': { id: 'gpu-power', queries: [{ expr: () => 'nvidia_smi_power_draw_watts', legend: gpuLegend }] },
  'gpu-temp': { id: 'gpu-temp', queries: [{ expr: () => 'nvidia_smi_temperature_gpu', legend: gpuLegend }] },

  'vllm-requests': {
    id: 'vllm-requests',
    queries: [
      { expr: () => 'vllm:num_requests_running', legend: l => `${l.model_name ?? '?'} running` },
      { expr: () => 'vllm:num_requests_waiting', legend: l => `${l.model_name ?? '?'} waiting` },
    ],
  },
  'vllm-throughput': {
    id: 'vllm-throughput',
    queries: [
      { expr: w => `rate(vllm:prompt_tokens_total[${w}])`, legend: l => `${l.model_name ?? '?'} prompt tok/s` },
      { expr: w => `rate(vllm:generation_tokens_total[${w}])`, legend: l => `${l.model_name ?? '?'} gen tok/s` },
    ],
  },
  'vllm-ttft': {
    id: 'vllm-ttft',
    queries: [
      { expr: w => `histogram_quantile(0.5, sum by (le, model_name) (rate(vllm:time_to_first_token_seconds_bucket[${w}]))) * 1000`, legend: l => `${l.model_name ?? '?'} p50 ms` },
      { expr: w => `histogram_quantile(0.95, sum by (le, model_name) (rate(vllm:time_to_first_token_seconds_bucket[${w}]))) * 1000`, legend: l => `${l.model_name ?? '?'} p95 ms` },
    ],
  },
  'vllm-kv-cache': { id: 'vllm-kv-cache', queries: [{ expr: () => 'vllm:kv_cache_usage_perc * 100', legend: modelLegend }] },

  'tei-rate': { id: 'tei-rate', queries: [{ expr: w => `rate(te_embed_count[${w}]) * 60`, legend: () => 'embeds/min' }] },

  'litellm-requests': {
    id: 'litellm-requests',
    queries: [{ expr: w => `sum by (model) (increase(litellm_requests_total[${w}])) > 0`, legend: modelLegend }],
  },
  'litellm-tokens': {
    id: 'litellm-tokens',
    queries: [{ expr: w => `sum by (model) (increase(litellm_total_tokens[${w}])) > 0`, legend: modelLegend }],
  },
  'litellm-spend': {
    id: 'litellm-spend',
    queries: [{ expr: w => `sum by (model) (increase(litellm_total_spend[${w}])) > 0`, legend: modelLegend }],
  },
  'litellm-cache-ratio': {
    id: 'litellm-cache-ratio',
    queries: [{
      expr: w => `sum(rate(litellm_cache_hits_total[${w}])) / (sum(rate(litellm_cache_hits_total[${w}])) + sum(rate(litellm_cache_misses_total[${w}]))) * 100`,
      legend: () => 'cache hit %',
    }],
  },
}

export type SnapshotQueryId =
  | 'gpuInfo' | 'gpuUtil' | 'gpuMemUsed' | 'gpuMemTotal' | 'gpuTemp' | 'gpuPower' | 'gpuPowerLimit'
  | 'engineRunning' | 'engineWaiting' | 'up' | 'probes' | 'spend'

// nvidia-gpu is scraped for the GPU panels rather than for a health-strip entry, so it is
// not in the catalog and has to be unioned in explicitly.
const EXTRA_UP_JOBS = ['nvidia-gpu']

// PromQL string literals use Go escaping, so a lone "\." is a parse error
// (unknown escape sequence U+002E). The backslash has to survive the string literal to
// reach the regex engine, which means emitting two of them.
const rePart = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&')

export function buildUpQuery(services: RigServiceDef[] = defaultRigServices()): string {
  const jobs = [...new Set([...services.filter(s => s.source === 'up' && s.job).map(s => s.job!), ...EXTRA_UP_JOBS])]
  return `up{job=~"${jobs.map(rePart).join('|')}"}`
}

export function buildProbesQuery(
  services: RigServiceDef[] = defaultRigServices(),
  rigHost = '192.168.2.25'
): string {
  // Off-rig probes are matched by their own substring; everything else is a target on the
  // rig host, covered by one wildcard rather than a term per port.
  const offRig = services.filter(s => s.source === 'probes' && s.instanceContains).map(s => s.instanceContains!)
  const onRig = services.some(s => s.source === 'probes' && !s.instanceContains)
  const terms = [
    ...new Set(offRig.map(h => `https://${rePart(h)}`)),
    ...(onRig ? [`http://${rePart(rigHost)}:.*`] : [])
  ]
  return `probe_success{instance=~"${terms.join('|')}"}`
}

/** The snapshot catalog with the service-derived expressions filled in from live config. */
export function buildSnapshotQueries(services: RigServiceDef[], rigHost: string): Record<SnapshotQueryId, string> {
  return { ...SNAPSHOT_QUERIES, up: buildUpQuery(services), probes: buildProbesQuery(services, rigHost) }
}

export const SNAPSHOT_QUERIES: Record<SnapshotQueryId, string> = {
  gpuInfo: 'nvidia_smi_gpu_info',
  gpuUtil: 'nvidia_smi_utilization_gpu_ratio * 100',
  gpuMemUsed: 'nvidia_smi_memory_used_bytes',
  gpuMemTotal: 'nvidia_smi_memory_total_bytes',
  gpuTemp: 'nvidia_smi_temperature_gpu',
  gpuPower: 'nvidia_smi_power_draw_watts',
  gpuPowerLimit: 'nvidia_smi_enforced_power_limit_watts',
  engineRunning: 'vllm:num_requests_running',
  engineWaiting: 'vllm:num_requests_waiting',
  // vllm-vision was retired (stopped + disabled 2026-06-19) and its scrape job removed 2026-08-19.
  // Placeholders. The service-derived expressions are built per request by
  // buildSnapshotQueries() from the configured catalog, so job names live in exactly
  // one place instead of being duplicated into a regex that silently drifts.
  up: buildUpQuery(),
  // Every blackbox probe on the AI rig (reranker, Speaches STT, Kokoro/Chatterbox TTS, ComfyUI,
  // Heretic llama.cpp — added to Prometheus 2026-08-19) plus the public LiteLLM edge.
  probes: buildProbesQuery(),
  spend: 'topk(10, litellm_total_spend > 0)',
}

// --- Public rig status (GET /api/public/rig) ---------------------------------------------
// The unauthenticated endpoint fans out ONLY these snapshot ids (no `spend`, no power) plus
// `PUBLIC_RIG_EXTRA_QUERIES`. Kept as named catalog entries so the public surface is explicit
// and reviewable in one place, exactly like the private catalogs above.
export const PUBLIC_RIG_SNAPSHOT_IDS: SnapshotQueryId[] = [
  'gpuInfo', 'gpuUtil', 'gpuMemUsed', 'gpuMemTotal', 'gpuTemp',
  'engineRunning', 'engineWaiting', 'up', 'probes'
]

export type PublicRigExtraQueryId
  = 'tokens24h' | 'modelTokens24h' | 'modelRequests24h'
    | 'vllmPrompt24h' | 'vllmGen24h' | 'llamaPrompt24h' | 'llamaGen24h'
export const PUBLIC_RIG_EXTRA_QUERIES: Record<PublicRigExtraQueryId, string> = {
  // LiteLLM GATEWAY tokens (what the litellm-tokens panel and the daily rollup read). Kept as a
  // breakdown line only: it under-counts the rig ~7x because MyMind's voice loop and other
  // clients call vLLM directly, so the public total counts local inference at the engines below.
  tokens24h: 'sum(increase(litellm_total_tokens[24h]))',
  // Local inference at the source engines (complete, direct + routed): vLLM + llama.cpp counters.
  vllmPrompt24h: 'sum(increase(vllm:prompt_tokens_total[24h]))',
  vllmGen24h: 'sum(increase(vllm:generation_tokens_total[24h]))',
  llamaPrompt24h: 'sum(increase(llamacpp:prompt_tokens_total[24h]))',
  llamaGen24h: 'sum(increase(llamacpp:tokens_predicted_total[24h]))',
  // The "model roster": every model LiteLLM routed to in the last 24h. Ranked by tokens (the
  // honest usage signal for LLMs), requests kept as a secondary count. vLLM engines alone
  // under-report the rig: llama.cpp, TEI, TTS and image gen all go through LiteLLM.
  modelTokens24h: 'sum by (model) (increase(litellm_total_tokens[24h])) > 0',
  modelRequests24h: 'sum by (model) (increase(litellm_requests_total[24h])) > 0'
}

// Service ids (from snapshot.ts SERVICES) that are user-facing enough to publish. The
// LiteLLM exporter/edge probe and Prometheus itself are plumbing and stay private.
export function publicRigServiceIds(services: RigServiceDef[] = defaultRigServices()): string[] {
  return services.filter(s => s.public).map(s => s.id)
}
