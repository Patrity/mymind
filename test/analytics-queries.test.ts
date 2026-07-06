import { describe, it, expect } from 'vitest'
import { RANGE_PANELS, SNAPSHOT_QUERIES, resolveGpuLabel } from '../server/lib/analytics/queries'

const GPU_LABELS = { 'abc-123': 'Vision (PNY)' }

describe('query catalog', () => {
  it('contains exactly the 13 spec panels', () => {
    expect(Object.keys(RANGE_PANELS).sort()).toEqual([
      'gpu-power', 'gpu-temp', 'gpu-util', 'gpu-vram',
      'litellm-cache-ratio', 'litellm-requests', 'litellm-spend', 'litellm-tokens',
      'tei-rate', 'vllm-kv-cache', 'vllm-requests', 'vllm-throughput', 'vllm-ttft',
    ])
  })

  it('every panel produces non-empty PromQL for a window and a legend for empty labels', () => {
    for (const p of Object.values(RANGE_PANELS)) {
      expect(p.id).toBeTruthy()
      expect(p.queries.length).toBeGreaterThan(0)
      for (const q of p.queries) {
        expect(q.expr('5m')).toMatch(/\S/)
        expect(typeof q.legend({}, {})).toBe('string')
      }
    }
  })

  it('gpu panels legend via the gpuLabels map, falling back to short uuid', () => {
    const q = RANGE_PANELS['gpu-util']!.queries[0]!
    expect(q.legend({ uuid: 'abc-123' }, GPU_LABELS)).toBe('Vision (PNY)')
    expect(q.legend({ uuid: 'ffffeeee-1234' }, GPU_LABELS)).toBe('GPU ffffeeee')
  })

  it('rate-based exprs interpolate the window', () => {
    expect(RANGE_PANELS['vllm-throughput']!.queries[0]!.expr('7m')).toContain('[7m]')
  })

  it('snapshot set covers gpu/engine/up/probe/spend', () => {
    expect(Object.keys(SNAPSHOT_QUERIES).sort()).toEqual([
      'engineRunning', 'engineWaiting', 'gpuInfo', 'gpuMemTotal', 'gpuMemUsed',
      'gpuPower', 'gpuPowerLimit', 'gpuTemp', 'gpuUtil', 'probes', 'spend', 'up',
    ])
  })

  it('resolveGpuLabel falls back to shortened uuid', () => {
    expect(resolveGpuLabel('abc-123', GPU_LABELS)).toBe('Vision (PNY)')
    expect(resolveGpuLabel('deadbeef-cafe', {})).toBe('GPU deadbeef')
  })
})
