import { describe, it, expect, vi } from 'vitest'
import { AiAllFailedError } from '@mymind/core/lib/ai/registry/errors'
import { EMPTY_REPLY_ERROR } from '@mymind/core/lib/ai/chat'
import {
  parseAudit,
  auditMessages,
  auditMemory,
  AUDIT_PROMPT_VERSION,
  AUDIT_VERDICTS,
  AUDIT_SYSTEM_PROMPT
} from '@mymind/core/lib/memory/extract-v3'

describe('parseAudit', () => {
  it('parses a clean reply', () => {
    const raw = JSON.stringify({ keep: 0.9, verdict: 'keep', reason: 'Stable fact about the system.' })
    expect(parseAudit(raw)).toEqual({ ok: true, keep: 0.9, verdict: 'keep', reason: 'Stable fact about the system.' })
  })

  it('parses a fenced reply', () => {
    const raw = '```json\n' + JSON.stringify({ keep: 0.2, verdict: 'transient', reason: 'Build status, will change.' }) + '\n```'
    expect(parseAudit(raw)).toEqual({ ok: true, keep: 0.2, verdict: 'transient', reason: 'Build status, will change.' })
  })

  it('parses prose before the JSON', () => {
    const raw = 'Here is my audit:\n' + JSON.stringify({ keep: 0.75, verdict: 'redundant', reason: 'Duplicates another memory.' })
    expect(parseAudit(raw)).toEqual({ ok: true, keep: 0.75, verdict: 'redundant', reason: 'Duplicates another memory.' })
  })

  // Review Focus 1 / deferred T3: a reply cut off by the token cap must be a failure, not a guess.
  it('a truncated JSON reply is a parse failure', () => {
    expect(parseAudit('{"keep": 0.8, "verdict": "keep", "reason": "Durable bec').ok).toBe(false)
    expect(parseAudit('```json\n{"keep": 0.8, "verdict": "ke').ok).toBe(false)
  })

  it('clamps keep 1.4 to 1', () => {
    const raw = JSON.stringify({ keep: 1.4, verdict: 'keep', reason: 'Fine.' })
    const out = parseAudit(raw)
    expect(out.ok).toBe(true)
    expect(out.ok && out.keep).toBe(1)
  })

  it('clamps a negative keep to 0', () => {
    const raw = JSON.stringify({ keep: -0.3, verdict: 'wrong_scope', reason: 'Filed as agent but is about Tony.' })
    const out = parseAudit(raw)
    expect(out.ok).toBe(true)
    expect(out.ok && out.keep).toBe(0)
  })

  it('gives ok:false for an unknown verdict', () => {
    const raw = JSON.stringify({ keep: 0.9, verdict: 'maybe', reason: 'Unclear.' })
    const out = parseAudit(raw)
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.error).toMatch(/verdict/i)
  })

  it('gives ok:false for empty input', () => {
    expect(parseAudit('')).toEqual({ ok: false, error: 'empty reply' })
    expect(parseAudit('   ')).toEqual({ ok: false, error: 'empty reply' })
  })

  it('gives ok:false for prose with no JSON at all', () => {
    const out = parseAudit('I cannot answer that.')
    expect(out.ok).toBe(false)
  })

  it('gives ok:false when keep is missing or not a number', () => {
    const out = parseAudit(JSON.stringify({ verdict: 'keep', reason: 'ok' }))
    expect(out.ok).toBe(false)
  })

  it('trims a 500-char reason to 200', () => {
    const longReason = 'x'.repeat(500)
    const raw = JSON.stringify({ keep: 0.9, verdict: 'keep', reason: longReason })
    const out = parseAudit(raw)
    expect(out.ok).toBe(true)
    expect(out.ok && out.reason).toHaveLength(200)
    expect(out.ok && out.reason).toBe('x'.repeat(200))
  })

  it('defaults a missing reason to an empty string rather than failing', () => {
    const raw = JSON.stringify({ keep: 0.9, verdict: 'keep' })
    const out = parseAudit(raw)
    expect(out.ok).toBe(true)
    expect(out.ok && out.reason).toBe('')
  })

  it('every AUDIT_VERDICTS entry round-trips', () => {
    for (const verdict of AUDIT_VERDICTS) {
      const raw = JSON.stringify({ keep: 0.5, verdict, reason: 'r' })
      const out = parseAudit(raw)
      expect(out.ok).toBe(true)
      expect(out.ok && out.verdict).toBe(verdict)
    }
  })

  it('is string-aware around braces inside the reason', () => {
    const raw = JSON.stringify({ keep: 0.6, verdict: 'keep', reason: 'Mentions "}" inline, not a closing brace.' })
    const out = parseAudit(raw)
    expect(out.ok).toBe(true)
    expect(out.ok && out.reason).toBe('Mentions "}" inline, not a closing brace.')
  })
})

describe('auditMessages', () => {
  it('includes the age, the project, and the content', () => {
    const msgs = auditMessages({ content: 'MyMind uses Drizzle ORM.', project: 'mymind', ageDays: 42, scope: 'agent' })
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toEqual({ role: 'system', content: AUDIT_SYSTEM_PROMPT })
    expect(msgs[1]!.role).toBe('user')
    expect(msgs[1]!.content).toContain('42')
    expect(msgs[1]!.content).toContain('mymind')
    expect(msgs[1]!.content).toContain('MyMind uses Drizzle ORM.')
  })

  it('renders project: none when the memory carries no project', () => {
    const msgs = auditMessages({ content: 'Tony prefers pnpm.', project: null, ageDays: 1, scope: 'user' })
    expect(msgs[1]!.content).toContain('none')
    expect(msgs[1]!.content).toContain('1 day')
    expect(msgs[1]!.content).not.toContain('1 days')
  })
})

describe('auditMemory', () => {
  it('calls the bulk chain with the audit messages and parses the reply', async () => {
    const chatFn = vi.fn(async () => ({ text: JSON.stringify({ keep: 0.9, verdict: 'keep', reason: 'Still durable.' }), model: 'bulk-model-b' }))
    const out = await auditMemory({ content: 'A fact.', project: 'mymind', ageDays: 10, scope: 'agent' }, { chatFn: chatFn as never })
    expect(chatFn).toHaveBeenCalledTimes(1)
    const [alias, messages, opts] = chatFn.mock.calls[0] as unknown as [string, { role: string, content: string }[], { temperature?: number, maxTokens?: number }]
    expect(alias).toBe('bulk')
    expect(messages).toEqual(auditMessages({ content: 'A fact.', project: 'mymind', ageDays: 10, scope: 'agent' }))
    expect(opts).toEqual({ temperature: 0, maxTokens: 300 })
    // `model` is whichever chain member answered (chatWithModel), recorded as audit_model.
    expect(out).toEqual({ ok: true, keep: 0.9, verdict: 'keep', reason: 'Still durable.', model: 'bulk-model-b' })
  })

  it('returns ok:false when the stubbed chatFn throws', async () => {
    const chatFn = vi.fn(async () => { throw new Error('fetch failed') })
    const out = await auditMemory({ content: 'A fact.', project: null, ageDays: 0, scope: 'agent' }, { chatFn: chatFn as never })
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.error).toBe('fetch failed')
    // A thrown call is a TRANSPORT failure: the scorer must not count it against the row.
    expect('transport' in out && out.transport).toBe(true)
  })

  it('an empty reply from every chain member is a content failure', async () => {
    const chatFn = vi.fn(async () => {
      throw new AiAllFailedError('bulk', [{ label: 'a', error: EMPTY_REPLY_ERROR }, { label: 'b', error: EMPTY_REPLY_ERROR }])
    })
    const out = await auditMemory({ content: 'A fact.', project: null, ageDays: 0, scope: 'agent' }, { chatFn: chatFn as never })
    expect(out.ok).toBe(false)
    expect('transport' in out).toBe(false)
  })

  it('a chain where any member failed for another reason stays transport', async () => {
    const chatFn = vi.fn(async () => {
      throw new AiAllFailedError('bulk', [{ label: 'a', error: EMPTY_REPLY_ERROR }, { label: 'b', error: '[POST] 503' }])
    })
    const out = await auditMemory({ content: 'A fact.', project: null, ageDays: 0, scope: 'agent' }, { chatFn: chatFn as never })
    expect('transport' in out && out.transport).toBe(true)
  })

  // Final review I1: a poison row every chain member refuses (400/413/422) must be charged, or it
  // stays at the front of every batch and trips the audit breaker each time.
  it.each([400, 413, 422])('every chain member refusing with %i is a content failure', async (status) => {
    const chatFn = vi.fn(async () => {
      throw new AiAllFailedError('bulk', [{ label: 'a', error: `[POST] ${status}`, status }, { label: 'b', error: `[POST] ${status}`, status }])
    })
    const out = await auditMemory({ content: 'A fact.', project: null, ageDays: 0, scope: 'agent' }, { chatFn: chatFn as never })
    expect(out.ok).toBe(false)
    expect('transport' in out).toBe(false)
  })

  it('a blank reply plus a 400 refusal is still a content failure', async () => {
    const chatFn = vi.fn(async () => {
      throw new AiAllFailedError('bulk', [{ label: 'a', error: EMPTY_REPLY_ERROR }, { label: 'b', error: '[POST] 400', status: 400 }])
    })
    const out = await auditMemory({ content: 'A fact.', project: null, ageDays: 0, scope: 'agent' }, { chatFn: chatFn as never })
    expect('transport' in out).toBe(false)
  })

  it.each([
    ['a 400 plus a 503', [400, 503]],
    ['401 everywhere (bad key)', [401, 401]],
    ['429 everywhere (rate limit)', [429, 429]],
    ['408 everywhere', [408, 408]]
  ])('%s stays transport', async (_name, statuses) => {
    const chatFn = vi.fn(async () => {
      throw new AiAllFailedError('bulk', statuses.map((status, i) => ({ label: `m${i}`, error: `[POST] ${status}`, status })))
    })
    const out = await auditMemory({ content: 'A fact.', project: null, ageDays: 0, scope: 'agent' }, { chatFn: chatFn as never })
    expect('transport' in out && out.transport).toBe(true)
  })

  it('a 4xx attempt with no status recorded stays transport (never guess from the message)', async () => {
    const chatFn = vi.fn(async () => { throw new AiAllFailedError('bulk', [{ label: 'a', error: '[POST] 400 Bad Request' }]) })
    const out = await auditMemory({ content: 'A fact.', project: null, ageDays: 0, scope: 'agent' }, { chatFn: chatFn as never })
    expect('transport' in out && out.transport).toBe(true)
  })

  it('a bad reply is a content failure, not a transport one', async () => {
    const chatFn = vi.fn(async () => ({ text: 'Looks durable to me.', model: 'm' }))
    const out = await auditMemory({ content: 'A fact.', project: null, ageDays: 0, scope: 'agent' }, { chatFn: chatFn as never })
    expect(out.ok).toBe(false)
    expect('transport' in out).toBe(false)
  })
})

describe('audit prompt constants', () => {
  it('is versioned and lists exactly the spec verdicts', () => {
    expect(AUDIT_PROMPT_VERSION).toBe('audit-v2')
    expect(AUDIT_VERDICTS).toEqual(['keep', 'transient', 'redundant', 'wrong_scope', 'belongs_in_doc'])
  })

  it('restates the extract-v3 criteria verbatim', () => {
    expect(AUDIT_SYSTEM_PROMPT).toContain('JUDGE THE FACT, NOT ITS WORDING')
    expect(AUDIT_SYSTEM_PROMPT).toContain('Below 0.6 = do not extract')
  })

  it('audit-v2: judges durability not plausibility, and calls point-in-time state transient', () => {
    expect(AUDIT_SYSTEM_PROMPT).toContain('JUDGE DURABILITY, NOT PLAUSIBILITY')
    expect(AUDIT_SYSTEM_PROMPT).toContain('POINT-IN-TIME STATE IS "transient"')
    expect(AUDIT_SYSTEM_PROMPT).toMatch(/project, plan, task, schedule or dataset/)
  })
})
