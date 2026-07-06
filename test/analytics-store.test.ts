// test/analytics-store.test.ts
import { describe, it, expect } from 'vitest'
import { defaultAnalyticsConfig, mergeAnalyticsConfig, parseAnalyticsConfigInput } from '../server/lib/analytics/store'

describe('analytics config store (pure parts)', () => {
  it('defaults point at the known homelab endpoints', () => {
    const d = defaultAnalyticsConfig()
    expect(d.prometheusUrl).toBe('http://192.168.2.90:9090')
    expect(d.litellmUrl).toBe('http://192.168.2.85:4000')
    expect(Object.keys(d.gpuLabels)).toHaveLength(5)
    expect(d.litellmMasterKeyEnc).toBeUndefined()
  })

  it('merge overlays stored values onto defaults and keeps unknown gpu labels', () => {
    const m = mergeAnalyticsConfig({ prometheusUrl: 'http://x:1', gpuLabels: { abc: 'My GPU' } })
    expect(m.prometheusUrl).toBe('http://x:1')
    expect(m.litellmUrl).toBe('http://192.168.2.85:4000')
    expect(m.gpuLabels).toEqual({ abc: 'My GPU' }) // stored map replaces default map wholesale
  })

  it('merge of null/undefined returns pure defaults', () => {
    expect(mergeAnalyticsConfig(null)).toEqual(defaultAnalyticsConfig())
    expect(mergeAnalyticsConfig(undefined)).toEqual(defaultAnalyticsConfig())
  })

  it('input schema rejects a non-URL prometheusUrl', () => {
    expect(() => parseAnalyticsConfigInput({ prometheusUrl: 'not a url' })).toThrow()
  })

  it('input schema accepts a partial patch and passes litellmMasterKey through', () => {
    const p = parseAnalyticsConfigInput({ litellmMasterKey: 'sk-1234' })
    expect(p).toEqual({ litellmMasterKey: 'sk-1234' })
  })

  it('input schema trims empty master key to undefined (means "no change")', () => {
    const p = parseAnalyticsConfigInput({ litellmMasterKey: '   ' })
    expect(p.litellmMasterKey).toBeUndefined()
  })
})
