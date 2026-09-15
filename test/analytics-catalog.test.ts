// test/analytics-catalog.test.ts
import { describe, it, expect } from 'vitest'
import { buildUpQuery, buildProbesQuery, publicRigServiceIds, buildSnapshotQueries } from '../server/lib/analytics/queries'
import { defaultRigServices } from '../server/lib/analytics/catalog'
import { buildSnapshot } from '../server/lib/analytics/snapshot'
import type { RigServiceDef } from '../server/lib/analytics/types'
import type { PromVectorResult } from '../server/lib/analytics/prom'

const v = (metric: Record<string, string>, value: string): PromVectorResult => ({ metric, value: [1751800000, value] })

describe('the health-strip catalog drives its own queries', () => {
  it('up{} is built from the catalog, so retiring a service stops scraping its job', () => {
    const withCoder: RigServiceDef[] = [
      { id: 'vllm-coder', label: 'vLLM Coder', source: 'up', job: 'vllm-coder', public: true },
      { id: 'tei', label: 'TEI', source: 'up', job: 'tei', public: true },
    ]
    expect(buildUpQuery(withCoder)).toContain('vllm-coder')
    // drop it from the catalog and the query stops asking for it, with no second edit
    expect(buildUpQuery(withCoder.slice(1))).not.toContain('vllm-coder')
  })

  it('probes match off-rig hosts by name and on-rig targets by one host wildcard', () => {
    const q = buildProbesQuery([
      { id: 'edge', label: 'Edge', source: 'probes', instanceContains: 'lite.example.com', public: false },
      { id: 'comfy', label: 'ComfyUI', source: 'probes', probeService: 'comfyui', port: '8188', public: true },
    ], '10.0.0.5')
    expect(q).toContain('https://lite\\.example\\.com')
    expect(q).toContain('http://10\\.0\\.0\\.5:.*')
  })

  it('a service is published only when the catalog says public', () => {
    const ids = publicRigServiceIds([
      { id: 'shown', label: 'Shown', source: 'up', job: 'a', public: true },
      { id: 'hidden', label: 'Hidden', source: 'up', job: 'b', public: false },
    ])
    expect(ids).toEqual(['shown'])
  })

  it('a probes service matches on its service label, and on host:port for older targets', () => {
    const catalog: RigServiceDef[] = [
      { id: 'labelled', label: 'Labelled', source: 'probes', probeService: 'flashnext-dev', port: '8009', public: true },
      { id: 'legacy', label: 'Legacy', source: 'probes', probeService: 'never-set', port: '8880', public: true },
    ]
    const snap = buildSnapshot({
      probes: [
        v({ service: 'flashnext-dev', instance: 'http://192.168.2.25:8009/health' }, '1'),
        v({ instance: 'http://192.168.2.25:8880/health' }, '0'), // no service label -> port fallback
      ]
    }, {}, catalog, '192.168.2.25')
    const by = Object.fromEntries(snap.services.map(s => [s.id, s.up]))
    expect(by['labelled']).toBe(true)
    expect(by['legacy']).toBe(false)
  })

  it('the port fallback is host-qualified so another host cannot answer for the rig', () => {
    const catalog: RigServiceDef[] = [
      { id: 'comfy', label: 'ComfyUI', source: 'probes', probeService: 'comfyui', port: '8188', public: true },
    ]
    const snap = buildSnapshot({
      probes: [v({ instance: 'http://10.9.9.9:8188/system_stats' }, '1')] // same port, wrong host
    }, {}, catalog, '192.168.2.25')
    expect(snap.services[0].up).toBeNull()
  })

  it('buildSnapshotQueries swaps in the derived expressions and leaves the rest alone', () => {
    const q = buildSnapshotQueries(defaultRigServices(), '192.168.2.25')
    expect(q.up).toBe(buildUpQuery(defaultRigServices()))
    expect(q.probes).toBe(buildProbesQuery(defaultRigServices(), '192.168.2.25'))
    expect(q.gpuInfo).toBe('nvidia_smi_gpu_info')
  })
})
