// server/lib/analytics/snapshot.ts
// Pure assembler: raw instant-query vectors -> SnapshotResponse. No I/O.
import type { PromVectorResult } from './prom'
import type { RigServiceDef } from './types'
import { defaultRigServices } from './catalog'
import type { SnapshotQueryId } from './queries'
import { resolveGpuLabel } from './queries'
import type { GpuSnapshot, ServiceHealth, SnapshotResponse } from '../../../shared/types/analytics'

// The health-strip catalog is configuration now (see lib/analytics/catalog.ts for the seed).
// `match` is derived from the declarative def so a service can be added, renamed or retired
// from the settings UI without a deploy, and so the PromQL that fetches it is built from the
// same data rather than a hand-maintained regex that drifts.
//
// Probe targets carry a `service` label from prometheus.yml; the port fallback keeps older
// configs working. vllm-vision was retired 2026-06-19 and its job removed 2026-08-19.
// vllm-coder followed when flash-next took over the coding workload.
function serviceMatcher(s: RigServiceDef, rigHost: string): (l: Record<string, string>) => boolean {
  if (s.source === 'up') return l => !!s.job && l.job === s.job
  return (l) => {
    const instance = l.instance ?? ''
    if (s.probeService && l.service === s.probeService) return true
    if (s.instanceContains && instance.includes(s.instanceContains)) return true
    // Host-qualified so a port cannot collide with the same port on another target.
    if (s.port && instance.includes(`${rigHost}:${s.port}`)) return true
    return false
  }
}

const num = (r: PromVectorResult | undefined): number | null => {
  if (!r) return null
  const n = parseFloat(r.value[1])
  return Number.isFinite(n) ? n : null
}

export function buildSnapshot(
  results: Partial<Record<SnapshotQueryId, PromVectorResult[]>>,
  gpuLabels: Record<string, string>,
  catalog: RigServiceDef[] = defaultRigServices(),
  rigHost = '192.168.2.25',
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
        label: resolveGpuLabel(uuid, gpuLabels, r.metric.name),
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
  const services: ServiceHealth[] = catalog.map((s) => {
    const vec = s.source === 'up' ? upVec : probeVec
    const hit = vec.find(r => serviceMatcher(s, rigHost)(r.metric))
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
