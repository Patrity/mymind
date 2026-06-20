import { describe, it, expect, beforeAll } from 'vitest'
import { encryptSecret, decryptSecret } from '../ai/registry/crypto'
import { isValidSecretName, lastFour } from './secrets'

beforeAll(() => { process.env.BETTER_AUTH_SECRET ||= 'test-secret-test-secret-test-secret-32' })

describe('secret name validation', () => {
  it('accepts UPPER_SNAKE env names', () => expect(isValidSecretName('GITHUB_TOKEN')).toBe(true))
  it('rejects names with shell-hostile chars', () => {
    for (const n of ['a b', 'a=b', 'a;b', '1ABC', '']) expect(isValidSecretName(n)).toBe(false)
  })
})
describe('lastFour', () => {
  it('shows only the trailing 4 chars', () => expect(lastFour('ghp_abcd1234')).toBe('1234'))
})
describe('crypto roundtrip (reused helper)', () => {
  it('encrypts then decrypts', () => expect(decryptSecret(encryptSecret('s3cr3t'))).toBe('s3cr3t'))
})
