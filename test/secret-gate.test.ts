// Stack review 2026-10-19 (D1): the write-time secret gate. Clef's `noul contains_secret ≥ 0.7`
// separated the 4 real credential values from 99 negatives on the live store (M3 §E3, 100 %/100 %
// against hand labels; the highest negative was 0.67). Policy: flag + redact, never drop; fail OPEN
// on any transport problem so a Clef outage can never block a memory write.
import { describe, it, expect, vi } from 'vitest'
import { estimateTokens } from '@mymind/core/lib/chunking/chunk-markdown'
import {
  gateSecret, withSecretReviewTag, redactEvidence, SECRET_REVIEW_TAG, SECRET_GATE_TIMEOUT_MS, SECRET_GATE_MAX_TOKENS
} from '@mymind/core/lib/memory/secret-gate'
import { REDACTED } from '@mymind/core/lib/memory/redact-credentials'

const CFG = { baseURL: 'http://clef.invalid/v1', apiKey: 'k', model: 'clef-flash' }
const ON = { enabled: 'auto' as const, threshold: 0.7 }
const answer = (noul: number) => async () => ({ model: 'clef-flash', answers: { contains_secret: { type: 'noul' as const, noul } } })
const TEXT = 'The BlueBubbles API password is Copenflagen11 (query param on every request).'

describe('gateSecret', () => {
  it('flags and redacts when contains_secret is at or above the threshold', async () => {
    const r = await gateSecret(TEXT, { ask: answer(0.83), cfg: CFG, config: ON })
    expect(r.outcome).toBe('flagged')
    expect(r.flagged).toBe(true)
    expect(r.score).toBe(0.83)
    expect(r.text).not.toContain('Copenflagen11')
    expect(r.text).toContain(REDACTED)
    expect(r.redactions).toBe(1)
  })

  it('returns the text unchanged below the threshold', async () => {
    const r = await gateSecret(TEXT, { ask: answer(0.67), cfg: CFG, config: ON })
    expect(r).toMatchObject({ outcome: 'clear', flagged: false, score: 0.67, text: TEXT, redactions: 0 })
  })

  it('honours a configured threshold', async () => {
    const r = await gateSecret(TEXT, { ask: answer(0.67), cfg: CFG, config: { enabled: 'auto', threshold: 0.6 } })
    expect(r.flagged).toBe(true)
  })

  it('fails open with a warning on a timeout', async () => {
    const warn = vi.fn()
    const ask = vi.fn(async () => {
      throw new DOMException('signal timed out', 'TimeoutError')
    })
    const r = await gateSecret(TEXT, { ask, cfg: CFG, config: ON, warn })
    expect(r).toMatchObject({ outcome: 'unavailable', flagged: false, text: TEXT })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toMatch(/secret gate/i)
  })

  it('fails open with a warning when Clef is unreachable', async () => {
    const warn = vi.fn()
    const ask = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const r = await gateSecret(TEXT, { ask, cfg: CFG, config: ON, warn })
    expect(r).toMatchObject({ outcome: 'unavailable', flagged: false, text: TEXT })
    expect(warn).toHaveBeenCalledOnce()
  })

  it('asks with the 1.5 s timeout and the contains_secret noul only', async () => {
    const ask = vi.fn(answer(0.1))
    await gateSecret(TEXT, { ask, cfg: CFG, config: ON })
    const [state, questions, cfg, opts] = ask.mock.calls[0] as unknown as [string, Record<string, { type: string, instructions: string }>, typeof CFG, { timeoutMs: number }]
    expect(state).toBe(TEXT)
    expect(Object.keys(questions)).toEqual(['contains_secret'])
    expect(questions.contains_secret!.type).toBe('noul')
    expect(questions.contains_secret!.instructions).toMatch(/password, API key, token, private key, or connection string/)
    expect(cfg).toBe(CFG)
    expect(opts.timeoutMs).toBe(SECRET_GATE_TIMEOUT_MS)
    expect(SECRET_GATE_TIMEOUT_MS).toBe(1500)
    // D3 A2: one attempt only — askJev's 429 back-off would otherwise stretch a "1.5 s fail-open"
    // to 15–23 s per memory write when the key is rate-limited.
    expect((opts as { maxAttempts?: number }).maxAttempts).toBe(1)
  })

  it('fails open promptly on a 429 from LiteLLM instead of backing off (D3 A2)', async () => {
    const warn = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '5' } })))
    try {
      const started = Date.now()
      const r = await gateSecret(TEXT, { cfg: CFG, config: ON, warn }) // the REAL askJev
      expect(r).toMatchObject({ outcome: 'unavailable', flagged: false, text: TEXT })
      expect(Date.now() - started).toBeLessThan(SECRET_GATE_TIMEOUT_MS)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fails open at the overall 1.5 s deadline even if the client never settles (D3 A2)', async () => {
    vi.useFakeTimers()
    try {
      const warn = vi.fn()
      const ask = vi.fn(() => new Promise<never>(() => {})) // hangs forever
      const p = gateSecret(TEXT, { ask, cfg: CFG, config: ON, warn })
      let settled = false
      void p.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(SECRET_GATE_TIMEOUT_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(2)
      expect(settled).toBe(true)
      await expect(p).resolves.toMatchObject({ outcome: 'unavailable', flagged: false, text: TEXT })
      expect(warn.mock.calls[0]![0]).toMatch(/secret gate/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('truncates the state to the token budget but redacts the full text', async () => {
    const ask = vi.fn(answer(0.9))
    const long = `${TEXT}\n` + 'filler words here '.repeat(1500) + '\npassword: tail-secret-99'
    const r = await gateSecret(long, { ask, cfg: CFG, config: ON })
    const state = (ask.mock.calls[0] as unknown as [string])[0]
    expect(estimateTokens(state)).toBeLessThanOrEqual(SECRET_GATE_MAX_TOKENS)
    expect(r.text).not.toContain('tail-secret-99')
  })

  it('is off when the jev slot is not configured (default `auto`)', async () => {
    const ask = vi.fn(answer(0.99))
    const r = await gateSecret(TEXT, { ask, cfg: null, config: ON })
    expect(r).toMatchObject({ outcome: 'off', flagged: false, text: TEXT })
    expect(ask).not.toHaveBeenCalled()
  })

  it('is off when explicitly disabled even with Clef configured', async () => {
    const ask = vi.fn(answer(0.99))
    const r = await gateSecret(TEXT, { ask, cfg: CFG, config: { enabled: false, threshold: 0.7 } })
    expect(r.outcome).toBe('off')
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('withSecretReviewTag', () => {
  it('appends the review tag once', () => {
    expect(withSecretReviewTag(['a'])).toEqual(['a', SECRET_REVIEW_TAG])
    expect(withSecretReviewTag(['a', SECRET_REVIEW_TAG])).toEqual(['a', SECRET_REVIEW_TAG])
    expect(withSecretReviewTag(undefined)).toEqual([SECRET_REVIEW_TAG])
    expect(SECRET_REVIEW_TAG).toBe('needs-review:secret')
  })
})

// D3 A3: the extractor's verbatim `quote` (and `reasoning`) is the transcript line that CONTAINS
// the value, so redacting `content` alone still stored the credential raw, one column over.
describe('redactEvidence', () => {
  it('redacts every string field of each evidence entry and leaves the rest intact', () => {
    const out = redactEvidence([
      { sessionId: 's1', msgIds: ['m1'], quote: 'the password is Copenflagen11 ok', reasoning: 'states password is Copenflagen11', mergedAt: '2026-10-20T01:00:00.000Z' },
      'not an object',
      null
    ])
    expect(out).toHaveLength(3)
    const e = out[0] as Record<string, unknown>
    expect(e.quote).not.toContain('Copenflagen11')
    expect(e.reasoning).not.toContain('Copenflagen11')
    expect(e.quote).toContain(REDACTED)
    expect(e.sessionId).toBe('s1')
    expect(e.msgIds).toEqual(['m1'])
    expect(e.mergedAt).toBe('2026-10-20T01:00:00.000Z')
    expect(out[1]).toBe('not an object')
    expect(out[2]).toBeNull()
  })

  it('passes undefined through', () => {
    expect(redactEvidence(undefined)).toBeUndefined()
  })
})
