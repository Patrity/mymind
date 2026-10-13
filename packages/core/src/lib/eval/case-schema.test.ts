// Task 4 fix round 1: the import caps (a suite arrives over HTTP).
import { describe, it, expect } from 'vitest'
import { EvalCaseJsonSchema, EvalSuiteJsonSchema, PROMPT_MAX, SPEC_LIST_MAX, SUITE_CASES_MAX } from './case-schema'
import { FIXTURE_BODY_MAX, FIXTURE_LIST_MAX, FIXTURE_STRING_MAX } from './setup'

const c = (i: number, over: Record<string, unknown> = {}) => ({ slug: `c-${i}`, prompt: 'p', ...over })
const fails = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }, path: PropertyKey[]) => {
  expect(r.success).toBe(false)
  expect(r.error!.issues.map(i => i.path.join('.'))).toContain(path.join('.'))
}

describe('import caps', () => {
  it('a suite holds at most 500 cases', () => {
    expect(EvalSuiteJsonSchema.safeParse({ name: 's', cases: Array.from({ length: SUITE_CASES_MAX }, (_, i) => c(i)) }).success).toBe(true)
    fails(EvalSuiteJsonSchema.safeParse({ name: 's', cases: Array.from({ length: SUITE_CASES_MAX + 1 }, (_, i) => c(i)) }), ['cases'])
  })

  it('prompt and rubric ≤ 20k chars', () => {
    expect(EvalCaseJsonSchema.safeParse(c(1, { prompt: 'x'.repeat(PROMPT_MAX) })).success).toBe(true)
    fails(EvalCaseJsonSchema.safeParse(c(1, { prompt: 'x'.repeat(PROMPT_MAX + 1) })), ['prompt'])
    fails(EvalCaseJsonSchema.safeParse(c(1, { rubric: 'x'.repeat(PROMPT_MAX + 1) })), ['rubric'])
  })

  it('a fixture body ≤ 200k chars (email, page, file, document); other fixture strings ≤ 2k', () => {
    const ok = 'x'.repeat(FIXTURE_BODY_MAX)
    const over = 'x'.repeat(FIXTURE_BODY_MAX + 1)
    expect(EvalCaseJsonSchema.safeParse(c(1, { setup: { gmail: { messages: [{ subject: 's', body: ok }] } } })).success).toBe(true)
    fails(EvalCaseJsonSchema.safeParse(c(1, { setup: { gmail: { messages: [{ subject: 's', body: over }] } } })), ['setup', 'gmail', 'messages', 0, 'body'])
    fails(EvalCaseJsonSchema.safeParse(c(1, { setup: { web: { pages: { 'https://a.example/': { html: over } } } } })), ['setup', 'web', 'pages', 'https://a.example/', 'html'])
    fails(EvalCaseJsonSchema.safeParse(c(1, { setup: { files: { 'a.txt': over } } })), ['setup', 'files', 'a.txt'])
    fails(EvalCaseJsonSchema.safeParse(c(1, { setup: { documents: [{ path: '/a.md', content: over }] } })), ['setup', 'documents', 0, 'content'])
    fails(EvalCaseJsonSchema.safeParse(c(1, { setup: { gmail: { messages: [{ subject: 'x'.repeat(FIXTURE_STRING_MAX + 1), body: 'b' }] } } })), ['setup', 'gmail', 'messages', 0, 'subject'])
  })

  it('fixture lists ≤ 500; spec lists ≤ 50; a regex ≤ 2k', () => {
    fails(EvalCaseJsonSchema.safeParse(c(1, { setup: { tasks: Array.from({ length: FIXTURE_LIST_MAX + 1 }, (_, i) => ({ title: `t${i}` })) } })), ['setup', 'tasks'])
    fails(EvalCaseJsonSchema.safeParse(c(1, { expected_actions: Array.from({ length: SPEC_LIST_MAX + 1 }, () => ({ tool: 't' })) })), ['expected_actions'])
    fails(EvalCaseJsonSchema.safeParse(c(1, { expected_content: ['a'.repeat(2_001)] })), ['expected_content', 0])
    fails(EvalCaseJsonSchema.safeParse(c(1, { setup: { files: Object.fromEntries(Array.from({ length: FIXTURE_LIST_MAX + 1 }, (_, i) => [`f${i}`, 'x'])) } })), ['setup', 'files'])
  })
})
