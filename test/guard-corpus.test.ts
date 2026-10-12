// Cycle 84 Task 3 (fix round 1) — the output guard on its corpus (test/fixtures/guard).
//
// Injection set: hidden text, role tokens/markers, exfil images/links, tool-call instructions, tag
// smuggling, base64, other languages, and the review's evasions (newline split, ZWJ, soft hyphen,
// sparse ZWSP, Cyrillic, fullwidth, Italian, Chinese, a polite paraphrase, a security article that
// also carries a payload). Benign set: real-world-shaped pages incl. the hard ones (security
// articles, OWASP, chat-template docs, API docs on system prompts, base64 in code, CSS hiding UI, a
// jailbreak test file) and the review's false-positive shapes (CodeCogs, QuickChart, fields={},
// DATA_ utm values, ?TOKEN=, api_key=YOUR_API_KEY, a <style> rule before visible text, a hidden code
// tab, "use the web_search API", a TODO comment).
//
// `web-*.html` fixtures go through the REAL web_fetch conversion (htmlToMarkdown), as a fetched page
// would. The heuristics are a router (ruling): only tag smuggling and role tokens in running text
// flag alone; everything else routes to the LLM. The ORACLE below stands in for a correct LLM — the
// real model's numbers are measured live and recorded in the task report.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../packages/core/src/lib/observability/record', () => ({ recordEvent: vi.fn(), withSpan: vi.fn(async (_i: unknown, fn: () => unknown) => fn()) }))

import { guardOutput, needsLlm, type GuardDeps } from '../packages/core/src/lib/agent/judge/guard'
import { resultText, scoreText } from '../packages/core/src/lib/agent/judge/guard-rules'
import { UNTRUSTED_NOTE } from '../packages/core/src/lib/google/untrusted'
import { WORKSPACE_UNTRUSTED_NOTE } from '../packages/core/src/lib/sandbox/paths'
import type { ResolvedModel } from '../packages/core/src/lib/ai/registry/types'

import { ROOT, sample, type Sample } from './guard-corpus-fixtures'

const load = (set: Sample['set']) => readdirSync(join(ROOT, set)).sort().map(f => sample(set, f))
const injections = load('injection')
const benign = load('benign')

const J: ResolvedModel = { usage: 'judge', modelDefId: 'J', providerKind: 'openai-compatible', baseURL: 'http://x/v1', apiKey: null, modelId: 'J', label: 'J', dim: null, contextWindow: null }
/** The oracle LLM: right about every sample (confident), counting its calls. */
function oracle(s: Sample) {
  const call = vi.fn(async () => ({ injection: s.set === 'injection', confidence: 0.9, reasons: [] }))
  const deps: GuardDeps = { enabled: async () => true, chain: async () => [J], call }
  return { call, deps }
}
const judgeDown: GuardDeps = { enabled: async () => false }
const run = (s: Sample, deps: GuardDeps) => guardOutput({ tool: s.tool, source: s.source, result: s.result }, deps)

/** Benign samples that are SUSPICIOUS — with the judge down they are flagged (the ruling's
 *  documented fail-closed cost). Pinned so a change in routing is a visible decision. */
const BENIGN_FLAGGED_WHEN_JUDGE_DOWN = [
  'search-results-injection.txt',
  'web-chat-templates.html',
  'web-ctf-writeup.html',
  'web-graph-api-docs.html',
  'web-owasp-llm01.html',
  'web-security-blog-injection.html',
  'ws-api-docs-tabs.html',
  'ws-cookie-banner.html',
  'ws-guardrail-tests.py',
  'ws-todo-comment.md'
]

describe('guard corpus', () => {
  it('has ≥ 20 samples per set, covering every source and the required injection kinds', () => {
    expect(injections.length).toBeGreaterThanOrEqual(30)
    expect(benign.length).toBeGreaterThanOrEqual(30)
    for (const set of [injections, benign]) expect(new Set(set.map(s => s.source))).toEqual(new Set(['web', 'mail', 'workspace', 'child']))
    const labels = new Set(injections.flatMap(s => scoreText(resultText(s.result)).labels))
    for (const l of ['hidden-instructions', 'role-token', 'exfil-image', 'tool-call', 'invisible-tags', 'encoded-instructions']) expect(labels, l).toContain(l)
  })

  it('web fixtures really went through htmlToMarkdown (no page chrome left)', () => {
    for (const s of [...injections, ...benign].filter(x => x.tool === 'web_fetch')) {
      const c = (s.result as { content: string }).content
      expect(c, s.file).not.toContain('<script')
      expect(c, s.file).not.toContain('<nav')
    }
  })

  it('benign: nothing is flagged with the LLM tier deciding (false-positive budget 0)', async () => {
    const flagged: string[] = []
    for (const s of benign) if ((await run(s, oracle(s).deps)).flagged) flagged.push(s.file)
    expect(flagged).toEqual([])
  })

  it('benign: no flag-alone signal fires on any page (the router never decides a benign page by itself)', () => {
    expect(benign.filter(s => scoreText(resultText(s.result)).flagged).map(s => s.file)).toEqual([])
  })

  it('benign with the judge DOWN: exactly the suspicious pages are flagged (fail closed — documented cost)', async () => {
    const flagged: string[] = []
    for (const s of benign) if ((await run(s, judgeDown)).flagged) flagged.push(s.file)
    expect(flagged).toEqual(BENIGN_FLAGGED_WHEN_JUDGE_DOWN)
  })

  it('injections: recall ≥ 90% with heuristics + LLM (today: every sample)', async () => {
    const missed: string[] = []
    for (const s of injections) if (!(await run(s, oracle(s).deps)).flagged) missed.push(s.file)
    expect((injections.length - missed.length) / injections.length).toBeGreaterThanOrEqual(0.9)
    expect(missed).toEqual([])
  })

  it('injections with the judge DOWN: every sample is still flagged (flag-alone or suspicious → fail closed)', async () => {
    const missed: string[] = []
    for (const s of injections) if (!(await run(s, judgeDown)).flagged) missed.push(s.file)
    expect(missed).toEqual([])
  })

  it('the LLM is called exactly when spec D9 (fix round 1) says — computed independently of the verdict', async () => {
    for (const s of [...injections, ...benign]) {
      const { call, deps } = oracle(s)
      await run(s, deps)
      const text = resultText(s.result, new Set(['injectionWarning'])).split(UNTRUSTED_NOTE).join(' ').split(WORKSPACE_UNTRUSTED_NOTE).join(' ')
      const h = scoreText(text)
      const expected = !h.flagged && needsLlm(s.source, text.length, h)
      expect(call.mock.calls.length, s.file).toBe(expected ? 1 : 0)
    }
  })
})
