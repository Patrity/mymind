import { describe, it, expect, beforeAll } from 'vitest'
import { parseObsConfig, redactObsConfig } from '../server/lib/observability/config'
import { DEFAULT_CONFIG } from '../server/lib/observability/types'

beforeAll(() => { process.env.BETTER_AUTH_SECRET ||= 'test-secret-test-secret-test-secret' })

describe('parseObsConfig', () => {
  it('accepts the default config', () => {
    expect(parseObsConfig(DEFAULT_CONFIG).maxRows).toBe(500_000)
  })
  it('fills defaults for a partial doc', () => {
    const c = parseObsConfig({ version: 1 })
    expect(c.retainInfoDays).toBe(14)
    expect(c.alerts.email.enabled).toBe(false)
    expect(c.capture.model).toBe(true)
  })
  it('rejects a bad shape', () => {
    expect(() => parseObsConfig({ version: 1, retainInfoDays: 'soon' })).toThrow()
  })
})

describe('redactObsConfig', () => {
  it('strips the email apiKeyEnc, exposing only hasEmailKey', () => {
    const doc = parseObsConfig({ ...DEFAULT_CONFIG, alerts: { ...DEFAULT_CONFIG.alerts, email: { ...DEFAULT_CONFIG.alerts.email, apiKeyEnc: 'CIPHERTEXT' } } })
    const red = redactObsConfig(doc) as { alerts: { email: Record<string, unknown> } }
    expect(JSON.stringify(red)).not.toContain('CIPHERTEXT')
    expect(red.alerts.email.hasKey).toBe(true)
    expect('apiKeyEnc' in red.alerts.email).toBe(false)
  })
})
