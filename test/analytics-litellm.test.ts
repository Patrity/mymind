import { describe, it, expect } from 'vitest'
import { formatLitellmDate, normalizeSpendRow } from '../server/lib/analytics/litellm'

describe('formatLitellmDate', () => {
  it('formats a Date as UTC "YYYY-MM-DD HH:MM:SS"', () => {
    expect(formatLitellmDate(new Date('2026-07-06T10:00:02.500Z'))).toBe('2026-07-06 10:00:02')
  })

  it('is UTC-based regardless of local timezone (midnight boundary)', () => {
    expect(formatLitellmDate(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01 00:00:00')
  })
})

describe('normalizeSpendRow', () => {
  it('maps a full LiteLLM SpendLogs row', () => {
    const row = normalizeSpendRow({
      request_id: 'req-1',
      model: 'claude-haiku-4-5',
      spend: 0.00123,
      prompt_tokens: 100,
      completion_tokens: 20,
      startTime: '2026-07-06T10:00:00.000Z',
      endTime: '2026-07-06T10:00:02.500Z',
      cache_hit: 'True',
      metadata: { user_api_key_alias: 'mymind-prod', status: 'success' },
    })
    expect(row).toEqual({
      id: 'req-1',
      startedAt: '2026-07-06T10:00:00.000Z',
      model: 'claude-haiku-4-5',
      promptTokens: 100,
      completionTokens: 20,
      latencyMs: 2500,
      spendUsd: 0.00123,
      keyAlias: 'mymind-prod',
      cacheHit: true,
      status: 'success',
    })
  })

  it('is defensive: missing/odd fields become nulls, not throws', () => {
    const row = normalizeSpendRow({ request_id: 'req-2', model: 'qwen' })
    expect(row).toEqual({
      id: 'req-2', startedAt: '', model: 'qwen',
      promptTokens: null, completionTokens: null, latencyMs: null,
      spendUsd: null, keyAlias: null, cacheHit: null, status: null,
    })
  })

  it('parses boolean cache_hit and failure status from error_information', () => {
    const row = normalizeSpendRow({
      request_id: 'r3', model: 'm', cache_hit: false,
      metadata: { error_information: { error_class: 'Timeout' } },
    })
    expect(row.cacheHit).toBe(false)
    expect(row.status).toBe('failure')
  })
})
