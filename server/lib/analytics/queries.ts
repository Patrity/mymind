// server/lib/analytics/queries.ts
// THE named query catalog — the security boundary. Endpoints only ever execute
// PromQL defined here; the client can only name a panel id.
// Metric names verified live against the homelab exporters on 2026-07-06.

export interface RangeQueryDef {
  expr: (window: string) => string
  legend: (labels: Record<string, string>, gpuLabels: Record<string, string>) => string
}
export interface RangePanelDef { id: string, queries: RangeQueryDef[] }

export function resolveGpuLabel(uuid: string, gpuLabels: Record<string, string>): string {
  return gpuLabels[uuid] ?? `GPU ${uuid.slice(0, 8)}`
}

const gpuLegend: RangeQueryDef['legend'] = (l, g) => resolveGpuLabel(l.uuid ?? '?', g)
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
  up: 'up{job=~"vllm-coder|vllm-vision|tei|llama-cpp-autocomplete|litellm|nvidia-gpu|prometheus"}',
  probes: 'probe_success{instance=~"https://lite.costanzoclan.com|http://192.168.2.25:8883/health"}',
  spend: 'topk(10, litellm_total_spend > 0)',
}
