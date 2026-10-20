// Stack review 2026-10-19 (D1): span-level credential redaction, applied ONLY after Clef's
// `contains_secret` says a value is present (M3 §E3 — the regex alone is 7.5 % precise, so it must
// never be the trigger; it is the scalpel, Clef is the gate).
import { describe, it, expect } from 'vitest'
import { redactCredentials, REDACTED } from '@mymind/core/lib/memory/redact-credentials'

describe('redactCredentials', () => {
  it('redacts a prose password value and keeps the sentence', () => {
    const r = redactCredentials('The Mac Mini `bridget` account password is Copenflagen11! (note the trailing bang).')
    expect(r.text).not.toContain('Copenflagen11')
    expect(r.text).toContain(`password is ${REDACTED}`)
    expect(r.text).toContain('(note the trailing bang)')
    expect(r.hits).toBe(1)
  })

  it('redacts key=value and key: value assignments', () => {
    const r = redactCredentials('set API_KEY=abcd1234efgh and password: "hunter22" in .env')
    expect(r.text).not.toMatch(/abcd1234efgh|hunter22/)
    expect(r.hits).toBe(2)
  })

  it('redacts known token prefixes and bearer tokens', () => {
    const r = redactCredentials('key sk-e6uNWBc8fzgPjPUtUeBfsg, hf_yqTELnGQuDXRXLxds, Bearer FlashNextDev2026 and mm_Q7xk9aLpT2vR8sWz')
    expect(r.text).not.toMatch(/sk-e6uN|hf_yqTE|FlashNextDev2026|mm_Q7xk/)
    expect(r.hits).toBe(4)
  })

  it('redacts only the password in a connection string', () => {
    const r = redactCredentials('DATABASE_URL postgres://bridget:s3cretPW@192.168.2.80:5432/bridget')
    expect(r.text).toContain(`postgres://bridget:${REDACTED}@192.168.2.80:5432/bridget`)
  })

  it('redacts a whole private key block', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\nAAAA\n-----END OPENSSH PRIVATE KEY-----'
    const r = redactCredentials(`deploy key:\n${key}\nend`)
    expect(r.text).not.toContain('b3BlbnNzaC')
    expect(r.text).toContain(REDACTED)
  })

  it('leaves text that merely names a secret untouched', () => {
    const s = 'The GitHub secrets are PROD_NEO4J_URI and PROD_NEO4J_PASSWORD; HASS_TOKEN lives in ~/.hermes/.env.'
    const r = redactCredentials(s)
    expect(r.text).toBe(s)
    expect(r.hits).toBe(0)
  })

  // D3 review A1 (2026-10-20): every line below was MEASURED being mangled by the first version
  // (bare `auth` inside "author"/"OAuth", `is` + any ≥4-char word, a URL port+path eaten as a
  // password). A flagged memory legitimately holds prose next to its credential, and the raw value
  // is gone by design once redacted — so ordinary prose must come through byte-for-byte.
  describe('does not eat ordinary prose in a flagged text (D3 A1 regressions)', () => {
    it.each([
      'The author said "hello world" to the crowd.',
      'The secret is that the cache was cold.',
      'The token is used for pagination tokens: 1500',
      'Authors: "Alice Smith" wrote it. Authority: "high".',
      'OAuth: bearer flow; oauth=code grant.',
      'Fetch http://192.168.2.85:4000/v1@tag then done',
      'Fetch http://192.168.2.85:4000/v1/models then done',
      'the password is for the shared account, ask Tony'
    ])('%s', (s) => {
      const r = redactCredentials(s)
      expect(r.text).toBe(s)
      expect(r.hits).toBe(0)
    })
  })

  describe('still redacts real values after the tightening', () => {
    it.each([
      ['prose `is` + a digit', 'the token is Xk9pQ2mL7vR4 for the rig', 'Xk9pQ2mL7vR4'],
      ['prose `is` + mixed case, no digit', 'the passphrase is CorrectHorseBatteryStaple today', 'CorrectHorseBatteryStaple'],
      ['auth_token assignment (the one `auth` form kept)', 'export AUTH_TOKEN=abc123def456', 'abc123def456'],
      ['quoted value right after the keyword', 'rig api key: "FlashNextDev2026" (shared)', 'FlashNextDev2026'],
      ['connection string with a numeric password', 'use postgres://app:12345678@db:5432/x', '12345678'],
      ['keyword at the start of the text', 'password=Copenflagen11', 'Copenflagen11'],
      ['keyword directly followed by the value, no separator (extractor reasoning phrasing)', 'he gave the password Copenflagen11 here', 'Copenflagen11']
    ])('%s', (_name, s, value) => {
      const r = redactCredentials(s)
      expect(r.text).not.toContain(value)
      expect(r.text).toContain(REDACTED)
      expect(r.hits).toBe(1)
    })
  })
})
