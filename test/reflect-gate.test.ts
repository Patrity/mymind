import { describe, it, expect } from 'vitest'
import { gate, AUTO_PER_DAY, SIMILARITY_REJECT, SKILL_MAX_BYTES, SENSITIVE, type GateContext } from '../server/lib/agent/reflect/gate'
import { similarity, normaliseText } from '../server/lib/agent/reflect/similarity'
import type { Proposal } from '../server/lib/agent/reflect/schema'

const base: GateContext = { mode: 'on', input: 'Tony: always file receipts under /finance/receipts', targetAuthor: 'missing', recentRejections: [], validate: () => null, autoAppliedToday: 0, targetChangedWithin24h: false, jev: { answers: {}, risky: false, model: 'jev' } }
const p: Proposal = { kind: 'skill.create', target: 'file-receipts', content: '# File receipts\nPut receipts in /finance/receipts.', reason: 'Tony corrected it', confidence: 0.8, evidence: ['always file receipts under /finance/receipts'] }
const risky = { answers: { one_off: 0.7 }, risky: true, model: 'jev' }

describe('constants', () => {
  it('carry the spec values', () => {
    expect(AUTO_PER_DAY).toBe(5)
    expect(SIMILARITY_REJECT).toBe(0.8)
    expect(SKILL_MAX_BYTES).toBe(4096)
  })
  it('SENSITIVE matches whole words only', () => {
    expect(SENSITIVE.test('use the API key')).toBe(true)
    expect(SENSITIVE.test('rm -rf the folder')).toBe(true)
    expect(SENSITIVE.test('tokenizer and executive summary')).toBe(false)
  })
})

describe('gate — mode', () => {
  it('auto for a clean new skill', () => expect(gate(p, base)).toEqual({ route: 'auto', reasons: [] }))
  it('off drops', () => expect(gate(p, { ...base, mode: 'off' })).toEqual({ route: 'dropped', reasons: ['mode_off'] }))
  it('off drops even an otherwise-invalid proposal before anything else', () => {
    expect(gate({ ...p, evidence: ['not in input'] }, { ...base, mode: 'off' }).reasons).toEqual(['mode_off'])
  })
  it('review_only demotes', () => expect(gate(p, { ...base, mode: 'review_only' })).toEqual({ route: 'review', reasons: ['review_only'] }))
  it('review_only adds no reason to something already in review', () => {
    expect(gate({ ...p, kind: 'profile.edit', target: 'profile' }, { ...base, targetAuthor: 'human', mode: 'review_only' }).reasons).not.toContain('review_only')
  })
})

describe('gate — evidence', () => {
  it('drops paraphrased evidence', () => expect(gate({ ...p, evidence: ['file receipts in finance'] }, base)).toEqual({ route: 'dropped', reasons: ['evidence'] }))
  it('whitespace differences still match', () => expect(gate({ ...p, evidence: ['always  file receipts\nunder /finance/receipts'] }, base).route).toBe('auto'))
  it('case is exact', () => expect(gate({ ...p, evidence: ['ALWAYS file receipts'] }, base).route).toBe('dropped'))
  it('punctuation is exact', () => expect(gate({ ...p, evidence: ['always file receipts under finance receipts'] }, base).route).toBe('dropped'))
  it('one missing quote among good ones drops', () => {
    expect(gate({ ...p, evidence: ['always file receipts', 'something Tony never said'] }, base).route).toBe('dropped')
  })
  it('evidence is checked before the rejection memory and validity', () => {
    const r = gate({ ...p, evidence: ['nope nope'] }, { ...base, validate: () => 'bad', recentRejections: [{ kind: p.kind, target: p.target, content: p.content! }] })
    expect(r.reasons).toEqual(['evidence'])
  })
})

describe('gate — rejection memory', () => {
  it('recently rejected similar → dropped', () => expect(gate(p, { ...base, recentRejections: [{ kind: 'skill.create', target: 'file-receipts', content: p.content! }] })).toEqual({ route: 'dropped', reasons: ['rejected_recently'] }))
  it('a different target is not a match', () => expect(gate(p, { ...base, recentRejections: [{ kind: 'skill.create', target: 'other', content: p.content! }] }).route).toBe('auto'))
  it('a different kind is not a match', () => expect(gate(p, { ...base, recentRejections: [{ kind: 'skill.edit', target: 'file-receipts', content: p.content! }] }).route).toBe('auto'))
  it('dissimilar content is not a match', () => expect(gate(p, { ...base, recentRejections: [{ kind: 'skill.create', target: 'file-receipts', content: 'Something entirely unrelated about calendars and meetings.' }] }).route).toBe('auto'))
  it('matches a job.disable with no content against a rejected job.disable with no content', () => {
    const d: Proposal = { ...p, kind: 'job.disable', target: 'heartbeat', content: undefined }
    expect(gate(d, { ...base, targetAuthor: 'agent', recentRejections: [{ kind: 'job.disable', target: 'heartbeat', content: '' }] }).route).toBe('dropped')
  })
})

describe('gate — validity', () => {
  it('invalid → dropped with the validator reason', () => expect(gate(p, { ...base, validate: () => 'skill over 4 KB' })).toEqual({ route: 'dropped', reasons: ['invalid: skill over 4 KB'] }))
  it('edit of a missing target → dropped', () => expect(gate({ ...p, kind: 'skill.edit' }, base)).toEqual({ route: 'dropped', reasons: ['target_missing'] }))
  it('job.disable of a missing job → dropped', () => expect(gate({ ...p, kind: 'job.disable', content: undefined }, base).route).toBe('dropped'))
  it('create with a missing target is fine', () => expect(gate(p, base).route).toBe('auto'))
})

describe('gate — tier', () => {
  it('skill.edit of an agent skill → auto', () => expect(gate({ ...p, kind: 'skill.edit' }, { ...base, targetAuthor: 'agent' }).route).toBe('auto'))
  it('skill.edit of a human skill → review', () => expect(gate({ ...p, kind: 'skill.edit' }, { ...base, targetAuthor: 'human' })).toEqual({ route: 'review', reasons: ['tier'] }))
  it('job.edit of an agent job → auto', () => expect(gate({ ...p, kind: 'job.edit', target: 'heartbeat', content: 'x' }, { ...base, targetAuthor: 'agent' }).route).toBe('auto'))
  it('job.edit of a human job → review', () => expect(gate({ ...p, kind: 'job.edit', target: 'heartbeat', content: 'x' }, { ...base, targetAuthor: 'human' }).route).toBe('review'))
  it('profile edits always review', () => expect(gate({ ...p, kind: 'profile.edit', target: 'profile' }, { ...base, targetAuthor: 'human' }).route).toBe('review'))
  it('job.disable of an agent job still reviews', () => expect(gate({ ...p, kind: 'job.disable', target: 'heartbeat', content: undefined }, { ...base, targetAuthor: 'agent' }).route).toBe('review'))
  it('Jev never promotes a review', () => expect(gate({ ...p, kind: 'job.disable', target: 'heartbeat' }, { ...base, targetAuthor: 'human' }).route).toBe('review'))
})

describe('gate — sensitive', () => {
  it('sensitive skill → review', () => expect(gate({ ...p, content: 'Run the shell command…' }, base)).toEqual({ route: 'review', reasons: ['sensitive'] }))
  it('sensitive skill edit of an agent skill → review', () => expect(gate({ ...p, kind: 'skill.edit', content: 'Store the password here.' }, { ...base, targetAuthor: 'agent' }).route).toBe('review'))
  it('sensitive words in a job edit do not trip the skill rule', () => {
    expect(gate({ ...p, kind: 'job.edit', target: 'heartbeat', content: 'Delete nothing; just say hi.' }, { ...base, targetAuthor: 'agent' }).route).toBe('auto')
  })
})

describe('gate — Jev', () => {
  it('Jev risky demotes auto', () => expect(gate(p, { ...base, jev: risky })).toEqual({ route: 'review', reasons: ['jev_risky'] }))
  it('Jev unavailable demotes auto', () => expect(gate(p, { ...base, jev: 'unavailable' })).toEqual({ route: 'review', reasons: ['jev_unavailable'] }))
  it('Jev risky on a review item stays review (and is noted)', () => {
    const r = gate({ ...p, kind: 'profile.edit', target: 'profile' }, { ...base, targetAuthor: 'human', jev: risky })
    expect(r).toEqual({ route: 'review', reasons: ['tier', 'jev_risky'] })
  })
  it('Jev never rescues a drop', () => expect(gate({ ...p, evidence: ['nope nope'] }, { ...base, jev: { answers: {}, risky: false, model: 'jev' } }).route).toBe('dropped'))
})

describe('gate — caps', () => {
  it('the 5th auto of the day is still auto', () => expect(gate(p, { ...base, autoAppliedToday: 4 }).route).toBe('auto'))
  it('cap demotes the 6th auto', () => expect(gate(p, { ...base, autoAppliedToday: 5 })).toEqual({ route: 'review', reasons: ['cap'] }))
  it('a second change to a target in 24h → review', () => expect(gate({ ...p, kind: 'skill.edit' }, { ...base, targetAuthor: 'agent', targetChangedWithin24h: true })).toEqual({ route: 'review', reasons: ['cap'] }))
})

describe('gate — ordering', () => {
  it('collects sensitivity and Jev reasons in spec order; caps and review_only only speak for auto', () => {
    const r = gate({ ...p, content: 'Use the api key' }, { ...base, mode: 'review_only', jev: 'unavailable', autoAppliedToday: 9 })
    expect(r).toEqual({ route: 'review', reasons: ['sensitive', 'jev_unavailable'] })
  })
  it('cap is reported when it is what stops auto', () => {
    expect(gate(p, { ...base, mode: 'review_only', autoAppliedToday: 9 })).toEqual({ route: 'review', reasons: ['cap'] })
  })
  it('validity is checked before target_missing', () => {
    expect(gate({ ...p, kind: 'skill.edit' }, { ...base, validate: () => 'x' }).reasons).toEqual(['invalid: x'])
  })
  it('the rejection memory is checked before validity', () => {
    const r = gate(p, { ...base, validate: () => 'x', recentRejections: [{ kind: p.kind, target: p.target, content: p.content! }] })
    expect(r.reasons).toEqual(['rejected_recently'])
  })
})

describe('similarity', () => {
  it('identical → 1', () => expect(similarity('a b c d', 'a b c d')).toBe(1))
  it('disjoint → 0', () => expect(similarity('a b c d', 'e f g h')).toBe(0))
  it('both empty → 1', () => expect(similarity('', '  ')).toBe(1))
  it('one empty → 0', () => expect(similarity('a b c', '')).toBe(0))
  it('ignores case, punctuation and whitespace', () => expect(similarity('Put receipts, in /finance!', 'put   receipts in finance')).toBe(1))
  it('partial overlap is between 0 and 1', () => {
    const s = similarity('a b c d e', 'a b c d f')
    expect(s).toBeGreaterThan(0)
    expect(s).toBeLessThan(1)
    expect(s).toBeCloseTo(2 / 4)
  })
  it('short texts (under three words) still compare', () => {
    expect(similarity('hello there', 'hello there')).toBe(1)
    expect(similarity('hello there', 'goodbye')).toBe(0)
  })
  it('normaliseText lowercases, strips punctuation and collapses whitespace', () => {
    expect(normaliseText('  Hello,   WORLD!\n')).toBe('hello world')
  })
})
