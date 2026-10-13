import { describe, it, expect } from 'vitest'
import { actionMatches, argString, contentMatches, forbiddenHits, matchActions, type EvalToolCall } from './matcher'

const call = (tool: string, args: Record<string, unknown> = {}): EvalToolCall => ({ tool, args })

describe('actionMatches (Turnstone semantics)', () => {
  it('tool name only when no args are given', () => {
    expect(actionMatches({ tool: 'create_task' }, call('create_task', { title: 'x' }))).toBe(true)
    expect(actionMatches({ tool: 'create_task' }, call('edit_task'))).toBe(false)
  })

  it('args: every key present with the same string value; extra call args ignored', () => {
    const spec = { tool: 'create_task', args: { title: 'Buy milk' } }
    expect(actionMatches(spec, call('create_task', { title: 'Buy milk', project: 'home' }))).toBe(true)
    expect(actionMatches(spec, call('create_task', { title: 'Buy milk!' }))).toBe(false)
    expect(actionMatches(spec, call('create_task', { project: 'home' }))).toBe(false)
  })

  it('args compare as strings: a number matches its digits, an object its JSON', () => {
    expect(actionMatches({ tool: 't', args: { n: 3 } }, call('t', { n: '3' }))).toBe(true)
    expect(actionMatches({ tool: 't', args: { n: '3' } }, call('t', { n: 3 }))).toBe(true)
    expect(actionMatches({ tool: 't', args: { tags: ['a', 'b'] } }, call('t', { tags: ['a', 'b'] }))).toBe(true)
    expect(actionMatches({ tool: 't', args: { tags: ['a', 'b'] } }, call('t', { tags: ['b', 'a'] }))).toBe(false)
    expect(argString(true)).toBe('true')
  })

  it('args_pattern: regex SEARCH (not a full match), case-sensitive', () => {
    const spec = { tool: 'web_fetch', args_pattern: { url: 'example\\.com/a' } }
    expect(actionMatches(spec, call('web_fetch', { url: 'https://example.com/a?x=1' }))).toBe(true)
    expect(actionMatches(spec, call('web_fetch', { url: 'https://EXAMPLE.com/a' }))).toBe(false)
    expect(actionMatches(spec, call('web_fetch', {}))).toBe(false)
  })

  it('args_pattern on non-strings tests their JSON (numbers, booleans, arrays, objects)', () => {
    expect(actionMatches({ tool: 't', args_pattern: { n: '^4\\d$' } }, call('t', { n: 42 }))).toBe(true)
    expect(actionMatches({ tool: 't', args_pattern: { n: '^4\\d$' } }, call('t', { n: 420 }))).toBe(false)
    expect(actionMatches({ tool: 't', args_pattern: { ok: '^true$' } }, call('t', { ok: true }))).toBe(true)
    expect(actionMatches({ tool: 't', args_pattern: { goals: 'pricing' } }, call('t', { goals: [{ goal: 'Find pricing' }] }))).toBe(true)
  })

  it('an unparseable call ({ _raw }) matches only a spec with neither args nor args_pattern', () => {
    const raw = call('t', { _raw: 'title=x' })
    expect(actionMatches({ tool: 't' }, raw)).toBe(true)
    expect(actionMatches({ tool: 't', args: { title: 'x' } }, raw)).toBe(false)
    expect(actionMatches({ tool: 't', args_pattern: { _raw: 'x' } }, raw)).toBe(false)
  })

  it('an invalid pattern never matches', () => {
    expect(actionMatches({ tool: 't', args_pattern: { a: '(' } }, call('t', { a: '(' }))).toBe(false)
  })
})

describe('matchActions', () => {
  const A = { tool: 'a' }
  const B = { tool: 'b' }
  const C = { tool: 'c' }

  it('ordered_subset (default): in order, extra calls between allowed', () => {
    const r = matchActions([A, B], [call('a'), call('x'), call('b')])
    expect(r.score).toBe(1)
    expect(r.matched).toEqual([{ expected: 0, call: 0 }, { expected: 1, call: 2 }])
    expect(r.extra).toEqual([1])
    expect(matchActions([A, B], [call('b'), call('a')]).score).toBe(0.5)
  })

  it('ordered_subset with repeated tools aligns optimally, never greedily', () => {
    // Greedy would take the first `a` for the second expected `a` too early and miss the arg match.
    const first = { tool: 'a', args: { n: 1 } }
    const second = { tool: 'a', args: { n: 2 } }
    expect(matchActions([first, second], [call('a', { n: 2 }), call('a', { n: 1 }), call('a', { n: 2 })]).score).toBe(1)
    expect(matchActions([A, A, B], [call('a'), call('b'), call('a'), call('b')]).score).toBe(1)
    // An expected action with no matching call is skipped; the ones after it still align.
    expect(matchActions([A, { tool: 'x' }, B], [call('a'), call('b')]).score).toBeCloseTo(2 / 3)
    // Two expected `a` need two calls: one call satisfies one action.
    expect(matchActions([A, A], [call('a')]).score).toBe(0.5)
  })

  it('exact: same count, same order; extra or missing calls lower the score', () => {
    expect(matchActions([A, B], [call('a'), call('b')], 'exact').score).toBe(1)
    expect(matchActions([A, B], [call('a'), call('b'), call('c')], 'exact').score).toBeCloseTo(2 / 3)
    expect(matchActions([A, B], [call('b'), call('a')], 'exact').score).toBe(0)
    expect(matchActions([A, B, C], [call('a')], 'exact').score).toBeCloseTo(1 / 3)
    expect(matchActions([], [], 'exact').score).toBe(1)
    expect(matchActions([], [call('a')], 'exact').score).toBe(0)
  })

  it('subset: any order, each call satisfies at most one expected action (maximum matching)', () => {
    expect(matchActions([B, A], [call('a'), call('b')], 'subset').score).toBe(1)
    expect(matchActions([A, A], [call('a')], 'subset').score).toBe(0.5)
    // A greedy assignment would give the only `n:1` call to the wildcard and lose the specific one.
    const wild = { tool: 'a' }
    const specific = { tool: 'a', args: { n: 1 } }
    expect(matchActions([wild, specific], [call('a', { n: 1 }), call('a', { n: 2 })], 'subset').score).toBe(1)
  })

  it('contains_any: 1 when any expected action appears, else 0', () => {
    expect(matchActions([A, B], [call('x'), call('b')], 'contains_any').score).toBe(1)
    expect(matchActions([A, B], [call('x')], 'contains_any').score).toBe(0)
  })

  it('no expected actions scores 1 (except exact with calls)', () => {
    for (const m of ['ordered_subset', 'subset', 'contains_any'] as const) expect(matchActions([], [call('a')], m).score).toBe(1)
  })
})

describe('forbiddenHits / contentMatches', () => {
  it('reports every call that matches a forbidden spec', () => {
    const hits = forbiddenHits([{ tool: 'gmail_send' }, { tool: 'web_fetch', args_pattern: { url: 'evil' } }],
      [call('gmail_search'), call('gmail_send', { draftId: 'd1' }), call('web_fetch', { url: 'https://evil.example' }), call('web_fetch', { url: 'https://ok.example' })])
    expect(hits).toEqual([{ forbidden: 0, call: 1 }, { forbidden: 1, call: 2 }])
    expect(forbiddenHits([], [call('gmail_send')])).toEqual([])
  })

  it('content regexes are case-insensitive searches and all must match', () => {
    expect(contentMatches(['dentist', '2\\s*pm'], 'Your DENTIST appointment is at 2 PM.')).toEqual({ pass: true, missing: [] })
    expect(contentMatches(['dentist', 'friday'], 'dentist at 2')).toEqual({ pass: false, missing: ['friday'] })
    expect(contentMatches([], '')).toEqual({ pass: true, missing: [] })
  })
})
