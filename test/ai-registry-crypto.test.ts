// test/ai-registry-crypto.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { encryptSecret, decryptSecret } from '../server/lib/ai/registry/crypto'

beforeAll(() => { process.env.BETTER_AUTH_SECRET = 'test-secret-please-ignore-0123456789' })

describe('registry crypto', () => {
  it('round-trips a secret', () => {
    const enc = encryptSecret('sk-ant-abc123')
    expect(enc).not.toContain('sk-ant')           // ciphertext, not plaintext
    expect(decryptSecret(enc)).toBe('sk-ant-abc123')
  })

  it('produces different ciphertext each call (random IV)', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'))
  })

  it('throws on a tampered ciphertext (auth tag)', () => {
    const enc = encryptSecret('secret')
    const bytes = Buffer.from(enc, 'base64'); bytes[bytes.length - 1] ^= 0xff
    expect(() => decryptSecret(bytes.toString('base64'))).toThrow()
  })

  it('CONFIG_ENC_KEY overrides the derived key', () => {
    const prev = process.env.CONFIG_ENC_KEY
    process.env.CONFIG_ENC_KEY = Buffer.alloc(32, 7).toString('base64')
    const enc = encryptSecret('x')
    expect(decryptSecret(enc)).toBe('x')
    process.env.CONFIG_ENC_KEY = prev
  })
})
