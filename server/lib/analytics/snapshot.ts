// server/lib/analytics/snapshot.ts
// Pure assembler: raw instant-query vectors -> SnapshotResponse. No I/O.
import type { PromVectorResult } from './prom'
import type { SnapshotQueryId } from './queries'
import { resolveGpuLabel } from './queries'
import type { GpuSnapshot, ServiceHealth, SnapshotResponse } from '../../../shared/types/analytics'

// The fixed service list for the health strip. `match` is tested against up{}/probe_success vectors.
// Probe targets carry a `service` label from prometheus.yml; the port fallback keeps older
// configs working. vllm-vision was retired 2026-06-19 and its job removed 2026-08-19.
const rigProbe = (service: string, port: string) => (l: Record<string, string>) =>
  l.service === service || (l.instance ?? '').includes(`192.168.2.25:${port}`)

const SERVICES: { id: string, label: string, source: 'up' | 'probes', match: (l: Record<string, string>) => boolean }[] = [
  { id: 'vllm-coder', label: 'vLLM Coder', source: 'up', match: l => l.job === 'vllm-coder' },
  { id: 'llama-heretic', label: 'Heretic (llama.cpp)', source: 'probes', match: rigProbe('llama-heretic', '8007') },
  { id: 'tei', label: 'TEI Embeddings', source: 'up', match: l => l.job === 'tei' },
  { id: 'llama-autocomplete', label: 'Autocomplete', source: 'up', match: l => l.job === 'llama-cpp-autocomplete' },
  { id: 'reranker', label: 'Reranker', source: 'probes', match: rigProbe('reranker', '8883') },
  { id: 'speaches-stt', label: 'Speaches STT', source: 'probes', match: rigProbe('speaches-stt', '8881') },
  { id: 'kokoro-tts', label: 'Kokoro TTS', source: 'probes', match: rigProbe('kokoro-tts', '8880') },
  { id: 'chatterbox-tts', label: 'Chatterbox TTS', source: 'probes', match: rigProbe('chatterbox-tts', '8884') },
  { id: 'comfyui', label: 'ComfyUI', source: 'probes', match: rigProbe('comfyui', '8188') },
  { id: 'litellm-exporter', label: 'LiteLLM Exporter', source: 'up', match: l => l.job === 'litellm' },
  { id: 'litellm-edge', label: 'LiteLLM (edge)', source: 'probes', match: l => (l.instance ?? '').includes('lite.costanzoclan.com') },
  { id: 'prometheus', label: 'Prometheus', source: 'up', match: l => l.job === 'prometheus' },
]

const num = (r: PromVectorResult | undefined): number | null => {
  if (!r) return null
  const n = parseFloat(r.value[1])
  return Number.isFinite(n) ? n : null
}

export function buildSnapshot(
  results: Partial<Record<SnapshotQueryId, PromVectorResult[]>>,
  gpuLabels: Record<string, string>,
): SnapshotResponse {
  const byUuid = (rs: PromVectorResult[] | undefined) =>
    new Map((rs ?? []).map(r => [r.metric.uuid ?? '', r]))

  const info = results.gpuInfo ?? []
  const util = byUuid(results.gpuUtil)
  const memU = byUuid(results.gpuMemUsed)
  const memT = byUuid(results.gpuMemTotal)
  const temp = byUuid(results.gpuTemp)
  const pow = byUuid(results.gpuPower)
  const powL = byUuid(results.gpuPowerLimit)

  const gpus: GpuSnapshot[] = info
    .map((r) => {
      const uuid = r.metric.uuid ?? ''
      return {
        uuid,
        label: resolveGpuLabel(uuid, gpuLabels),
        utilPct: num(util.get(uuid)),
        vramUsedBytes: num(memU.get(uuid)),
        vramTotalBytes: num(memT.get(uuid)),
        tempC: num(temp.get(uuid)),
        powerW: num(pow.get(uuid)),
        powerLimitW: num(powL.get(uuid)),
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  const upVec = results.up ?? []
  const probeVec = results.probes ?? []
  const services: ServiceHealth[] = SERVICES.map((s) => {
    const vec = s.source === 'up' ? upVec : probeVec
    const hit = vec.find(r => s.match(r.metric))
    return { id: s.id, label: s.label, up: hit ? num(hit) === 1 : null }
  })

  const waiting = new Map((results.engineWaiting ?? []).map(r => [r.metric.model_name ?? '?', num(r) ?? 0]))
  const engines = (results.engineRunning ?? []).map(r => ({
    model: r.metric.model_name ?? '?',
    running: num(r) ?? 0,
    waiting: waiting.get(r.metric.model_name ?? '?') ?? 0,
  }))

  const spendByModel = (results.spend ?? [])
    .map(r => ({ model: r.metric.model ?? '?', usd: num(r) ?? 0 }))
    .sort((a, b) => b.usd - a.usd)

  return { gpus, services, engines, spendByModel }
}
