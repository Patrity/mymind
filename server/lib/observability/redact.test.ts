import { describe, it, expect } from 'vitest'
import { maskSecrets } from './redact'

describe('maskSecrets', () => {
  it('replaces every occurrence of each secret value', () => {
    expect(maskSecrets('token=ghp_abc123 again ghp_abc123', ['ghp_abc123'])).toBe('token=«redacted» again «redacted»')
  })
  it('ignores empty/short values (avoid masking everything)', () => {
    expect(maskSecrets('hello', ['', 'a'])).toBe('hello')
  })
})
