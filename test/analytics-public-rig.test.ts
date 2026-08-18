import { describe, it, expect } from 'vitest'
import { buildPublicRig } from '../server/lib/analytics/public-rig'
import { PUBLIC_RIG_SNAPSHOT_IDS, PUBLIC_RIG_EXTRA_QUERIES, PUBLIC_RIG_SERVICE_IDS, SNAPSHOT_QUERIES } from '../server/lib/analytics/queries'
import type { PromVectorResult } from '../server/lib/analytics/prom'
import type { SnapshotResponse } from '../shared/types/analytics'

const v = (metric: Record<string, string>, value: string): PromVectorResult => ({ metric, value: [1751800000, value] })

const snapshot: SnapshotResponse = {
  gpus: [{
    uuid: '24d1cd2c-76e0-8a7a-66be-48dc43b0e4ac', label: 'Coder A (Strix)', utilPct: 72, vramUsedBytes: 21_000_000_000,
    vramTotalBytes: 24_000_000_000, tempC: 61, powerW: 310, powerLimitW: 390
  }],
  services: [
    { id: 'vllm-coder', label: 'vLLM Coder', up: true },
    { id: 'litellm-exporter', label: 'LiteLLM Exporter', up: true },
    { id: 'litellm-edge', label: 'LiteLLM (edge)', up: true },
    { id: 'prometheus', label: 'Prometheus', up: true },
    { id: 'reranker', label: 'Reranker', up: null }
  ],
  engines: [{ model: 'qwen3.6-35b-a3b', running: 2, waiting: 0 }],
  spendByModel: [{ model: 'qwen3.6-35b-a3b', usd: 12.5 }]
}

describe('buildPublicRig', () => {
  it('copies only the allow-listed GPU fields (no uuid, no power)', () => {
    const out = buildPublicRig(snapshot, [], 1_700_000_000_000)
    expect(out.gpus).toEqual([{ label: 'Coder A (Strix)', utilPct: 72, vramUsedBytes: 21_000_000_000, vramTotalBytes: 24_000_000_000, tempC: 61 }])
    expect(JSON.stringify(out)).not.toContain('24d1cd2c')
    expect(JSON.stringify(out)).not.toContain('power')
  })

  it('never leaks spend', () => {
    const out = buildPublicRig(snapshot, [], 1_700_000_000_000) as unknown as Record<string, unknown>
    expect(out.spendByModel).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain('12.5')
    expect(JSON.stringify(out)).not.toContain('usd')
  })

  it('publishes only user-facing services and keeps the tri-state', () => {
    const out = buildPublicRig(snapshot, [], 1_700_000_000_000)
    expect(out.services.map(s => s.id)).toEqual(['vllm-coder', 'reranker'])
    expect(PUBLIC_RIG_SERVICE_IDS).not.toContain('vllm-vision') // retired engine, would only ever read down
    expect(out.services.find(s => s.id === 'reranker')?.up).toBeNull()
    for (const s of out.services) expect(PUBLIC_RIG_SERVICE_IDS).toContain(s.id)
  })

  it('tokens24h reads the scalar vector, null when the series is absent', () => {
    expect(buildPublicRig(snapshot, [v({}, '1240000')], 0).tokens24h).toBe(1_240_000)
    expect(buildPublicRig(snapshot, [], 0).tokens24h).toBeNull()
    expect(buildPublicRig(snapshot, undefined, 0).tokens24h).toBeNull()
    expect(buildPublicRig(snapshot, [v({}, 'NaN')], 0).tokens24h).toBeNull()
  })

  it('models24h is the LiteLLM roster: most-used first, zero/unknown dropped, capped', () => {
    const vec = [
      v({ model: 'kokoro' }, '12'), v({ model: 'ornith-1.0-35b' }, '840.4'), v({ model: 'qwen2.5-coder-3b' }, '311'),
      v({ model: 'ghost' }, '0'), v({}, '99')
    ]
    const out = buildPublicRig(snapshot, [], 0, vec)
    expect(out.models24h).toEqual([
      { model: 'ornith-1.0-35b', requests: 840 },
      { model: 'qwen2.5-coder-3b', requests: 311 },
      { model: 'kokoro', requests: 12 }
    ])
    const many = Array.from({ length: 30 }, (_, i) => v({ model: `m${i}` }, String(100 - i)))
    expect(buildPublicRig(snapshot, [], 0, many).models24h).toHaveLength(12)
    expect(buildPublicRig(snapshot, [], 0, undefined).models24h).toEqual([])
  })

  it('stamps generatedAt from the supplied clock', () => {
    expect(buildPublicRig(snapshot, [], 1_700_000_000_000).generatedAt).toBe('2023-11-14T22:13:20.000Z')
  })

  it('an empty snapshot (rig powered off) is empty arrays, not an error', () => {
    const out = buildPublicRig({ gpus: [], services: [], engines: [], spendByModel: [] }, [], 0)
    expect(out.gpus).toEqual([])
    expect(out.engines).toEqual([])
    expect(out.services).toEqual([])
  })
})

describe('public rig query catalog', () => {
  it('fans out only catalog ids and never the spend or power series', () => {
    for (const id of PUBLIC_RIG_SNAPSHOT_IDS) expect(SNAPSHOT_QUERIES[id]).toBeTypeOf('string')
    expect(PUBLIC_RIG_SNAPSHOT_IDS).not.toContain('spend')
    expect(PUBLIC_RIG_SNAPSHOT_IDS).not.toContain('gpuPower')
    expect(PUBLIC_RIG_SNAPSHOT_IDS).not.toContain('gpuPowerLimit')
  })

  it('tokens24h is a bounded increase over the litellm token series', () => {
    expect(PUBLIC_RIG_EXTRA_QUERIES.tokens24h).toBe('sum(increase(litellm_total_tokens[24h]))')
  })

  it('models24h is a bounded per-model increase over the litellm request series', () => {
    expect(PUBLIC_RIG_EXTRA_QUERIES.models24h).toBe('sum by (model) (increase(litellm_requests_total[24h])) > 0')
  })
})
