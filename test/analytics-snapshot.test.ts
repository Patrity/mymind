import { describe, it, expect } from 'vitest'
import { buildSnapshot } from '../server/lib/analytics/snapshot'
import type { PromVectorResult } from '../server/lib/analytics/prom'

const v = (metric: Record<string, string>, value: string): PromVectorResult => ({ metric, value: [1751800000, value] })

describe('buildSnapshot', () => {
  it('assembles gpus keyed by uuid with labels + all fields', () => {
    const snap = buildSnapshot({
      gpuInfo: [v({ uuid: 'aaa', name: 'NVIDIA GeForce RTX 3090' }, '1')],
      gpuUtil: [v({ uuid: 'aaa' }, '55')],
      gpuMemUsed: [v({ uuid: 'aaa' }, '1000')],
      gpuMemTotal: [v({ uuid: 'aaa' }, '2000')],
      gpuTemp: [v({ uuid: 'aaa' }, '61')],
      gpuPower: [v({ uuid: 'aaa' }, '250')],
      gpuPowerLimit: [v({ uuid: 'aaa' }, '350')],
    }, { aaa: 'Vision (PNY)' })
    expect(snap.gpus).toEqual([{
      uuid: 'aaa', label: 'Vision (PNY)', utilPct: 55, vramUsedBytes: 1000, vramTotalBytes: 2000,
      tempC: 61, powerW: 250, powerLimitW: 350,
    }])
  })

  it('missing per-gpu metrics become null, not 0', () => {
    const snap = buildSnapshot({ gpuInfo: [v({ uuid: 'bbb', name: 'Quadro P2000' }, '1')] }, {})
    expect(snap.gpus[0]).toMatchObject({ uuid: 'bbb', utilPct: null, tempC: null, powerW: null })
  })

  it('gpus are sorted by label for stable rendering', () => {
    const snap = buildSnapshot({
      gpuInfo: [v({ uuid: 'z' }, '1'), v({ uuid: 'a' }, '1')],
    }, { z: 'Alpha', a: 'Zulu' })
    expect(snap.gpus.map(g => g.label)).toEqual(['Alpha', 'Zulu'])
  })

  it('services merge up{} and probe_success into known service list; missing = null', () => {
    const snap = buildSnapshot({
      up: [v({ job: 'vllm-coder', instance: '192.168.2.25:8004' }, '1'), v({ job: 'litellm', instance: '192.168.2.85:9090' }, '0')],
      probes: [v({ job: 'blackbox-http', instance: 'https://lite.costanzoclan.com' }, '1')],
    }, {})
    const by = Object.fromEntries(snap.services.map(s => [s.id, s.up]))
    expect(by['vllm-coder']).toBe(true)
    expect(by['litellm-exporter']).toBe(false)
    expect(by['litellm-edge']).toBe(true)
    expect(by['vllm-vision']).toBeUndefined() // retired 2026-06-19, job removed 2026-08-19
    expect(by['kokoro-tts']).toBe(null) // probe not present in this fixture -> unknown, not down
  })

  it('rig probes match by service label or by port, and carry the tri-state', () => {
    const snap = buildSnapshot({
      probes: [
        v({ job: 'blackbox-http', service: 'kokoro-tts', instance: 'http://192.168.2.25:8880/health' }, '1'),
        v({ job: 'blackbox-http', instance: 'http://192.168.2.25:8881/health' }, '0'), // no service label: port fallback
        v({ job: 'blackbox-http', service: 'comfyui', instance: 'http://192.168.2.25:8188/system_stats' }, '1')
      ]
    }, {})
    const by = Object.fromEntries(snap.services.map(s => [s.id, s.up]))
    expect(by['kokoro-tts']).toBe(true)
    expect(by['speaches-stt']).toBe(false)
    expect(by['comfyui']).toBe(true)
    expect(by['chatterbox-tts']).toBe(null)
    expect(by['llama-heretic']).toBe(null)
  })

  it('engines pair running/waiting by model_name', () => {
    const snap = buildSnapshot({
      engineRunning: [v({ model_name: 'qwen3.6-35b-a3b' }, '2')],
      engineWaiting: [v({ model_name: 'qwen3.6-35b-a3b' }, '1')],
    }, {})
    expect(snap.engines).toEqual([{ model: 'qwen3.6-35b-a3b', running: 2, waiting: 1 }])
  })

  it('spendByModel sorted desc', () => {
    const snap = buildSnapshot({
      spend: [v({ model: 'a' }, '0.5'), v({ model: 'b' }, '1.25')],
    }, {})
    expect(snap.spendByModel).toEqual([{ model: 'b', usd: 1.25 }, { model: 'a', usd: 0.5 }])
  })

  it('empty input yields empty snapshot with full service list (all null)', () => {
    const snap = buildSnapshot({}, {})
    expect(snap.gpus).toEqual([])
    expect(snap.engines).toEqual([])
    expect(snap.services.length).toBeGreaterThanOrEqual(8)
    expect(snap.services.every(s => s.up === null)).toBe(true)
  })
})
