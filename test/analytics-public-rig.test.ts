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
    const out = buildPublicRig(snapshot, {}, 1_700_000_000_000)
    expect(out.gpus).toEqual([{ label: 'Coder A (Strix)', utilPct: 72, vramUsedBytes: 21_000_000_000, vramTotalBytes: 24_000_000_000, tempC: 61 }])
    expect(JSON.stringify(out)).not.toContain('24d1cd2c')
    expect(JSON.stringify(out)).not.toContain('power')
  })

  it('never leaks spend', () => {
    const out = buildPublicRig(snapshot, {}, 1_700_000_000_000) as unknown as Record<string, unknown>
    expect(out.spendByModel).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain('12.5')
    expect(JSON.stringify(out)).not.toContain('usd')
  })

  it('publishes only user-facing services and keeps the tri-state', () => {
    const out = buildPublicRig(snapshot, {}, 1_700_000_000_000)
    expect(out.services.map(s => s.id)).toEqual(['vllm-coder', 'reranker'])
    expect(PUBLIC_RIG_SERVICE_IDS).not.toContain('vllm-vision') // retired engine, job removed from Prometheus
    for (const id of ['speaches-stt', 'kokoro-tts', 'chatterbox-tts', 'comfyui', 'llama-heretic']) expect(PUBLIC_RIG_SERVICE_IDS).toContain(id)
    expect(out.services.find(s => s.id === 'reranker')?.up).toBeNull()
    for (const s of out.services) expect(PUBLIC_RIG_SERVICE_IDS).toContain(s.id)
  })

  it('tokens24h sums Claude Code + engine counters and never the LiteLLM gateway figure', () => {
    const out = buildPublicRig(snapshot, {
      claudeCodeTokens: 312_000_000,
      vllmPrompt: [v({}, '1708238')], vllmGen: [v({}, '26277')],
      llamaPrompt: [v({}, '0')], llamaGen: [v({}, '0')],
      tokens24h: [v({}, '248419')]
    }, 0)
    expect(out.tokensBreakdown24h).toEqual({ claudeCode: 312_000_000, vllm: 1_734_515, llamacpp: 0, litellm: 248_419 })
    expect(out.tokens24h).toBe(312_000_000 + 1_734_515)
  })

  it('tokens24h tolerates missing sources: partial sums, null only when everything is absent', () => {
    expect(buildPublicRig(snapshot, { vllmPrompt: [v({}, '100')] }, 0).tokens24h).toBe(100)
    expect(buildPublicRig(snapshot, { claudeCodeTokens: null, vllmPrompt: [v({}, 'NaN')] }, 0).tokens24h).toBeNull()
    expect(buildPublicRig(snapshot, {}, 0).tokensBreakdown24h).toEqual({ claudeCode: null, vllm: null, llamacpp: null, litellm: null })
    expect(buildPublicRig(snapshot, { tokens24h: [v({}, '5')] }, 0).tokens24h).toBeNull() // gateway alone is not a total
  })

  it('models24h is the LiteLLM roster: ranked by tokens, requests merged in, unknown/zero dropped, capped', () => {
    const tokens = [
      v({ model: 'unknown' }, '16503616'), v({ model: 'openai/qwen3.6-35b-a3b' }, '590000.4'),
      v({ model: 'huggingface/tei/Qwen/Qwen3-Embedding-4B' }, '30000'), v({ model: 'ghost' }, '0'), v({}, '99')
    ]
    const requests = [v({ model: 'openai/qwen3.6-35b-a3b' }, '15'), v({ model: 'kokoro' }, '96'), v({ model: 'unknown' }, '5')]
    const out = buildPublicRig(snapshot, { modelTokens: tokens, modelRequests: requests }, 0)
    expect(out.models24h).toEqual([
      { model: 'openai/qwen3.6-35b-a3b', tokens: 590000, requests: 15 },
      { model: 'huggingface/tei/Qwen/Qwen3-Embedding-4B', tokens: 30000, requests: 0 },
      { model: 'kokoro', tokens: 0, requests: 96 }
    ])
    expect(JSON.stringify(out)).not.toContain('unknown')
    const many = Array.from({ length: 30 }, (_, i) => v({ model: `m${i}` }, String(100 - i)))
    expect(buildPublicRig(snapshot, { modelTokens: many }, 0).models24h).toHaveLength(12)
    expect(buildPublicRig(snapshot, {}, 0).models24h).toEqual([])
  })

  it('stamps generatedAt from the supplied clock', () => {
    expect(buildPublicRig(snapshot, {}, 1_700_000_000_000).generatedAt).toBe('2023-11-14T22:13:20.000Z')
  })

  it('an empty snapshot (rig powered off) is empty arrays, not an error', () => {
    const out = buildPublicRig({ gpus: [], services: [], engines: [], spendByModel: [] }, {}, 0)
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

  it('engine token queries are bounded 24h increases at the source counters', () => {
    expect(PUBLIC_RIG_EXTRA_QUERIES.vllmPrompt24h).toBe('sum(increase(vllm:prompt_tokens_total[24h]))')
    expect(PUBLIC_RIG_EXTRA_QUERIES.vllmGen24h).toBe('sum(increase(vllm:generation_tokens_total[24h]))')
    expect(PUBLIC_RIG_EXTRA_QUERIES.llamaPrompt24h).toBe('sum(increase(llamacpp:prompt_tokens_total[24h]))')
    expect(PUBLIC_RIG_EXTRA_QUERIES.llamaGen24h).toBe('sum(increase(llamacpp:tokens_predicted_total[24h]))')
  })

  it('the roster reads bounded per-model increases over the litellm token and request series', () => {
    expect(PUBLIC_RIG_EXTRA_QUERIES.modelTokens24h).toBe('sum by (model) (increase(litellm_total_tokens[24h])) > 0')
    expect(PUBLIC_RIG_EXTRA_QUERIES.modelRequests24h).toBe('sum by (model) (increase(litellm_requests_total[24h])) > 0')
  })
})
