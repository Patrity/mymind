import { describe, it, expect } from 'vitest'
import type { EvalRunDTO, EvalToolLogEntry } from '@mymind/core/shared/types/eval'
import { EvalCaseJsonSchema } from '@mymind/core/lib/eval/case-schema'
import { alignToolLog, compareRuns, fromForm, issueAt, parseCaseText, pct, runProgress, sparkPoints, specLabel, toForm } from './display'

const call = (tool: string, status: EvalToolLogEntry['status'] = 'ok'): EvalToolLogEntry => ({ tool, args: {}, status, result: '', conversationId: 'c' })

describe('alignToolLog', () => {
  const expected = [{ tool: 'a' }, { tool: 'b' }, { tool: 'c' }]

  it('puts each matched call beside its expected action and a missing one before the next match', () => {
    // calls: x a c — b was never called; c matched expected 2.
    const rows = alignToolLog(expected, [call('x'), call('a'), call('c')], { mode: 'ordered_subset', matched: [{ expected: 0, call: 1 }, { expected: 2, call: 2 }], forbidden: [] })
    expect(rows.map(r => [r.kind, r.expected, r.call])).toEqual([
      ['extra', null, 0], ['matched', 0, 1], ['missing', 1, null], ['matched', 2, 2]
    ])
  })

  it('missing actions with no later match go at the end; with no calls at all every action is missing', () => {
    expect(alignToolLog(expected, [call('a')], { mode: 'ordered_subset', matched: [{ expected: 0, call: 0 }], forbidden: [] }).map(r => r.kind))
      .toEqual(['matched', 'missing', 'missing'])
    expect(alignToolLog(expected, [], { mode: 'ordered_subset', matched: [], forbidden: [] }).map(r => [r.kind, r.expected]))
      .toEqual([['missing', 0], ['missing', 1], ['missing', 2]])
  })

  it('under contains_any the unmatched alternatives are unused, not missing — unless none matched', () => {
    expect(alignToolLog(expected, [call('b')], { mode: 'contains_any', matched: [{ expected: 1, call: 0 }], forbidden: [] }).map(r => r.kind))
      .toEqual(['unused', 'matched', 'unused'])
    expect(alignToolLog(expected, [call('z')], { mode: 'contains_any', matched: [], forbidden: [] }).map(r => r.kind))
      .toEqual(['extra', 'missing', 'missing', 'missing'])
  })

  it('marks forbidden hits (on extra and matched calls alike) and denied / errored calls', () => {
    const rows = alignToolLog([{ tool: 'a' }], [call('a', 'denied'), call('send', 'ok'), call('send', 'error')], {
      mode: 'ordered_subset', matched: [{ expected: 0, call: 0 }], forbidden: [{ forbidden: 0, call: 1 }, { forbidden: 1, call: 1 }, { forbidden: 0, call: 0 }]
    })
    expect(rows.map(r => ({ k: r.kind, f: r.forbidden, x: r.failed }))).toEqual([
      { k: 'matched', f: [0], x: true }, { k: 'extra', f: [0, 1], x: false }, { k: 'extra', f: [], x: true }
    ])
  })

  it('ignores out-of-range alignment indexes (a case edited after the run) rather than crashing', () => {
    const rows = alignToolLog([{ tool: 'a' }], [call('a')], { mode: 'ordered_subset', matched: [{ expected: 5, call: 0 }, { expected: 0, call: 9 }], forbidden: [] })
    expect(rows.map(r => r.kind)).toEqual(['extra', 'missing'])
  })

  it('specLabel shows args and patterns', () => {
    expect(specLabel({ tool: 't', args: { a: 1 }, args_pattern: { b: 'x.*' } })).toBe('t(a=1, b~/x.*/)')
    expect(specLabel({ tool: 't' })).toBe('t')
  })
})

const run = (over: Partial<EvalRunDTO> & { cases?: Array<{ slug: string, mean: number | null, passed: boolean, holdout?: boolean }>, hashes?: Record<string, string>, nh?: number }): EvalRunDTO => ({
  id: 'r', suiteId: 's', status: 'done', gitSha: 'aaa', modelLabel: 'm', promptHash: 'p', toolsHash: 't', params: {}, error: null,
  startedAt: '2026-10-13T00:00:00Z', finishedAt: null,
  summary: {
    overall: { cases: 0, passed: 0, passRate: null, meanScore: null },
    nonHoldout: { cases: 2, passed: 1, passRate: over.nh ?? 0.5, meanScore: 0.6 },
    holdout: { cases: 0, passed: 0, passRate: null, meanScore: null },
    attempts: 6, failedAttempts: 0, tokens: 0, durationMs: 0, planned: 9,
    promptHashes: over.hashes ?? {},
    cases: (over.cases ?? []).map(c => ({ caseId: c.slug, slug: c.slug, holdout: !!c.holdout, attempts: 3, meanScore: c.mean, passed: c.passed, forbidden: false, failedAttempts: 0 }))
  },
  ...over
})

describe('compareRuns', () => {
  it('classifies each case and computes b − a deltas', () => {
    const a = run({ cases: [{ slug: 'fix', mean: 0.5, passed: false }, { slug: 'reg', mean: 1, passed: true }, { slug: 'up', mean: 0.2, passed: false }, { slug: 'down', mean: 0.6, passed: false }, { slug: 'eq', mean: 1, passed: true }, { slug: 'gone', mean: 1, passed: true }], nh: 0.5 })
    const b = run({ cases: [{ slug: 'fix', mean: 1, passed: true }, { slug: 'reg', mean: 0.5, passed: false }, { slug: 'up', mean: 0.4, passed: false }, { slug: 'down', mean: 0.3, passed: false }, { slug: 'eq', mean: 1, passed: true }, { slug: 'new', mean: 1, passed: true }], nh: 0.75 })
    const c = compareRuns(a, b)
    expect(Object.fromEntries(c.cases.map(r => [r.slug, r.change]))).toEqual({ down: 'worse', eq: 'same', fix: 'fixed', gone: 'removed', new: 'added', reg: 'regressed', up: 'better' })
    expect(c.cases.find(r => r.slug === 'reg')!.delta).toBeCloseTo(-0.5)
    expect(c.cases.find(r => r.slug === 'new')!.delta).toBeNull()
    expect(c.nonHoldout.delta).toBeCloseTo(0.25)
  })

  it('reports provenance differences and per-case prompt changes', () => {
    const a = run({ gitSha: 'aaa', modelLabel: 'qwen', cases: [{ slug: 'x', mean: 1, passed: true }, { slug: 'y', mean: 1, passed: true }], hashes: { x: 'h1', y: 'h2' } })
    const b = run({ gitSha: 'bbb', modelLabel: 'qwen', cases: [{ slug: 'x', mean: 1, passed: true }, { slug: 'y', mean: 1, passed: true }], hashes: { x: 'h1', y: 'CHANGED' } })
    const c = compareRuns(a, b)
    expect(c.provenance.map(p => [p.field, p.same])).toEqual([['Git SHA', false], ['Model', true], ['Prompt hash', true], ['Tools hash', true]])
    expect(c.cases.map(r => [r.slug, r.promptChanged])).toEqual([['x', false], ['y', true]])
  })
})

describe('progress, formatting, sparkline', () => {
  it('runProgress is attempts / planned, capped at 1; unknown plan is null', () => {
    expect(runProgress({ status: 'running', summary: { ...run({}).summary!, attempts: 3, planned: 9 } })).toEqual({ done: 3, planned: 9, ratio: 1 / 3 })
    expect(runProgress({ status: 'queued', summary: null })).toEqual({ done: 0, planned: null, ratio: null })
    expect(runProgress({ status: 'running', summary: { ...run({}).summary!, attempts: 10, planned: 9 } }).ratio).toBe(1)
  })
  it('pct', () => {
    expect(pct(0.875)).toBe('88%')
    expect(pct(null)).toBe('—')
  })
  it('sparkPoints maps [0,1] to the box (1 at the top), skipping nulls; one point is centred', () => {
    expect(sparkPoints([0, null, 1], 104, 24, 2)).toBe('2,22 102,2')
    expect(sparkPoints([0.5], 100, 20, 0)).toBe('50,10')
    expect(sparkPoints([], 10, 10)).toBe('')
  })
})

describe('case editor form ⇄ JSON', () => {
  const json = EvalCaseJsonSchema.parse({
    slug: 'task-create', prompt: 'Add a task', expected_actions: [{ tool: 'create_task', args_pattern: { title: '[Mm]ilk' } }],
    forbidden_actions: [{ tool: 'delete_task' }], expected_content: ['added', 'milk'], rubric: 'It confirms.',
    expected_approvals: [{ tool: 'exec' }], setup: { tasks: [{ title: 'old' }] }
  })

  it('round-trips a case through the form unchanged', () => {
    const out = fromForm(toForm(json))
    expect(out.issues).toEqual([])
    expect(out.json).toEqual(json)
  })

  it('pins bad JSON in an action row and schema errors to their paths', () => {
    const f = toForm(json)
    f.expectedActions[0]!.args = '{nope'
    f.forbiddenActions[0]!.argsPattern = '["array"]'
    f.nRuns = 99
    f.slug = 'Bad Slug'
    const out = fromForm(f)
    expect(out.json).toBeNull()
    expect(issueAt(out.issues, 'expected_actions', 0, 'args')).toEqual(expect.stringMatching(/not valid JSON/))
    expect(issueAt(out.issues, 'forbidden_actions', 0, 'args_pattern')).toEqual(expect.stringMatching(/JSON object/))
    expect(issueAt(out.issues, 'n_runs')).toBeTruthy()
    expect(issueAt(out.issues, 'slug')).toEqual(expect.stringMatching(/lower-case/))
    expect(issueAt(out.issues, 'prompt')).toBeUndefined()
  })

  it('an empty rubric is null; an invalid regex in the content lines is an issue at its index', () => {
    const f = toForm(json)
    f.rubric = '   '
    expect(fromForm(f).json!.rubric).toBeNull()
    f.expectedContent = 'ok\n(unclosed'
    expect(issueAt(fromForm(f).issues, 'expected_content', 1)).toEqual(expect.stringMatching(/regular expression/))
  })

  it('parseCaseText: a syntax error is one root issue; a schema error carries its path', () => {
    expect(parseCaseText('{').issues).toEqual([{ path: [], message: expect.stringMatching(/not valid JSON/) }])
    const bad = parseCaseText(JSON.stringify({ ...json, match_mode: 'fuzzy' }))
    expect(bad.json).toBeNull()
    expect(bad.issues[0]!.path).toEqual(['match_mode'])
    expect(parseCaseText(JSON.stringify(json)).json).toEqual(json)
  })
})
