import { describe, it, expect } from 'vitest'
import { shouldNotify, buildDigest } from '../server/lib/observability/notify'
import { DEFAULT_CONFIG } from '../server/lib/observability/types'
import type { ActivityInsert } from '../server/db/schema/activity-log'

const cfg = (over: Partial<typeof DEFAULT_CONFIG.alerts.email>) => ({
  ...DEFAULT_CONFIG,
  alerts: { ...DEFAULT_CONFIG.alerts, email: { ...DEFAULT_CONFIG.alerts.email, enabled: true, recipient: 'me@x.io', apiKeyEnc: 'k', ...over } }
})

describe('shouldNotify', () => {
  it('false when email disabled', () => {
    expect(shouldNotify(DEFAULT_CONFIG, 'error')).toBe(false)
  })
  it('true for error when enabled with a recipient + key', () => {
    expect(shouldNotify(cfg({}), 'error')).toBe(true)
  })
  it('respects minSeverity (warn excluded when threshold is error)', () => {
    expect(shouldNotify(cfg({ minSeverity: 'error' }), 'warn')).toBe(false)
    expect(shouldNotify(cfg({ minSeverity: 'warn' }), 'warn')).toBe(true)
  })
  it('false when enabled but no recipient/key', () => {
    expect(shouldNotify(cfg({ recipient: null }), 'error')).toBe(false)
    expect(shouldNotify(cfg({ apiKeyEnc: null }), 'error')).toBe(false)
  })
})

describe('buildDigest', () => {
  it('coalesces N errors into one subject + body', () => {
    const rows = [
      { name: 'enrich-input', kind: 'job', error: { message: 'parse failed' } },
      { name: 'chat:reasoning', kind: 'model', error: { message: 'no usable content' } }
    ] as unknown as ActivityInsert[]
    const d = buildDigest(rows)
    expect(d.subject).toContain('2')
    expect(d.text).toContain('enrich-input')
    expect(d.text).toContain('no usable content')
  })
})
