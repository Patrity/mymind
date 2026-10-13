// Cycle 85 (spec §3.4): Turnstone's tool-call matcher, ported
// (https://github.com/turnstonelabs/turnstone/blob/main/docs/eval.md).
//
// A call matches an action spec `{ tool, args?, args_pattern? }` when:
//   - the tool names are equal;
//   - every key of `args` is present in the call's args with the SAME STRING VALUE (extra call args
//     are ignored). Values compare as strings: a string as itself, anything else as its JSON — so
//     `{ n: 3 }` matches a call's `3` and `"3"`, and an object compares by its JSON;
//   - every key of `args_pattern` is present and its regex finds a match (re.search, not a full
//     match; case-sensitive) in the call's value, stringified the same way — so a pattern can test a
//     number, a boolean or an array/object's JSON;
//   - a call whose args could not be parsed (`{ _raw }` only) matches only a spec with neither.
//
// Modes (score = matched expected actions / expected actions, so a partial match scores partially):
//   ordered_subset (default) — the expected actions appear IN ORDER, other calls may sit between.
//                              Repeated tools are handled by an optimal alignment (LCS), never greedy:
//                              [a, b] against calls [a, a, b] scores 1.
//   exact                    — the calls ARE the expected actions, position by position, same count.
//                              Extra or missing calls lower the score (divided by the longer list).
//   subset                   — every expected action appears somewhere, any order, each call
//                              satisfying at most ONE expected action (maximum bipartite matching).
//   contains_any             — 1 when at least one expected action appears, else 0.
// No expected actions: 1 (exact: 1 only when there were no calls either).
//
// Forbidden actions (spec §3.4): any call matching any forbidden spec is a hit → the attempt scores 0.
import type { EvalActionSpec } from '../../db/schema/eval'

export type MatchMode = 'ordered_subset' | 'exact' | 'subset' | 'contains_any'

export interface EvalToolCall {
  tool: string
  /** The call's arguments as the model sent them (`{ _raw }` when they were not a JSON object). */
  args: Record<string, unknown>
}

export interface MatchResult {
  score: number
  /** Indexes of expected actions that matched (and the call each matched, -1 for contains_any misses). */
  matched: Array<{ expected: number; call: number }>
  unmatched: number[]
  /** Calls that matched no expected action. */
  extra: number[]
}

/** A value as the matcher compares it: a string as itself, anything else as its JSON. */
export function argString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined) return ''
  try { return JSON.stringify(v) ?? String(v) } catch { return String(v) }
}

function isRawOnly(args: Record<string, unknown>): boolean {
  const keys = Object.keys(args)
  return keys.length === 1 && keys[0] === '_raw'
}

/** Compiled once per spec: an invalid pattern never matches (import validates them anyway). */
function compile(spec: EvalActionSpec): (call: EvalToolCall) => boolean {
  const patterns = Object.entries(spec.args_pattern ?? {}).map(([k, p]) => {
    let re: RegExp | null
    try { re = new RegExp(p) } catch { re = null }
    return [k, re] as const
  })
  const exact = Object.entries(spec.args ?? {})
  const needsArgs = exact.length > 0 || patterns.length > 0
  return (call) => {
    if (call.tool !== spec.tool) return false
    if (!needsArgs) return true
    if (isRawOnly(call.args)) return false
    for (const [k, v] of exact) {
      if (!Object.prototype.hasOwnProperty.call(call.args, k)) return false
      if (argString(call.args[k]) !== argString(v)) return false
    }
    for (const [k, re] of patterns) {
      if (!re || !Object.prototype.hasOwnProperty.call(call.args, k)) return false
      if (!re.test(argString(call.args[k]))) return false
    }
    return true
  }
}

export function actionMatches(spec: EvalActionSpec, call: EvalToolCall): boolean {
  return compile(spec)(call)
}

export function matchActions(expected: EvalActionSpec[], calls: EvalToolCall[], mode: MatchMode = 'ordered_subset'): MatchResult {
  const preds = expected.map(compile)
  const m = (e: number, c: number) => preds[e]!(calls[c]!)
  let matched: Array<{ expected: number; call: number }> = []
  if (mode === 'exact') {
    for (let i = 0; i < Math.min(expected.length, calls.length); i++) if (m(i, i)) matched.push({ expected: i, call: i })
  } else if (mode === 'ordered_subset') {
    matched = lcs(expected.length, calls.length, m)
  } else if (mode === 'subset') {
    matched = bipartite(expected.length, calls.length, m)
  } else {
    for (let e = 0; e < expected.length; e++) {
      const c = calls.findIndex((_, i) => m(e, i))
      if (c >= 0) matched.push({ expected: e, call: c })
    }
  }
  const hit = new Set(matched.map(x => x.expected))
  const used = new Set(matched.map(x => x.call))
  let score: number
  if (mode === 'exact') {
    const n = Math.max(expected.length, calls.length)
    score = n === 0 ? 1 : matched.length / n
  } else if (!expected.length) score = 1
  else if (mode === 'contains_any') score = matched.length > 0 ? 1 : 0
  else score = matched.length / expected.length
  return {
    score,
    matched: matched.sort((a, b) => a.expected - b.expected),
    unmatched: expected.map((_, i) => i).filter(i => !hit.has(i)),
    extra: calls.map((_, i) => i).filter(i => !used.has(i))
  }
}

/** The longest in-order alignment of expected actions onto calls (DP; optimal with repeats). */
function lcs(ne: number, nc: number, m: (e: number, c: number) => boolean): Array<{ expected: number; call: number }> {
  const t: number[][] = Array.from({ length: ne + 1 }, () => new Array<number>(nc + 1).fill(0))
  for (let e = ne - 1; e >= 0; e--) {
    for (let c = nc - 1; c >= 0; c--) {
      t[e]![c] = m(e, c) ? 1 + t[e + 1]![c + 1]! : Math.max(t[e + 1]![c]!, t[e]![c + 1]!)
    }
  }
  const out: Array<{ expected: number; call: number }> = []
  let e = 0
  let c = 0
  while (e < ne && c < nc) {
    if (m(e, c) && t[e]![c] === 1 + t[e + 1]![c + 1]!) { out.push({ expected: e, call: c }); e++; c++ } else if (t[e + 1]![c]! >= t[e]![c + 1]!) e++
    else c++
  }
  return out
}

/** Maximum matching expected ↔ calls (Kuhn's augmenting paths): each call satisfies one action. */
function bipartite(ne: number, nc: number, m: (e: number, c: number) => boolean): Array<{ expected: number; call: number }> {
  const owner = new Array<number>(nc).fill(-1)
  const tryAssign = (e: number, seen: boolean[]): boolean => {
    for (let c = 0; c < nc; c++) {
      if (seen[c] || !m(e, c)) continue
      seen[c] = true
      if (owner[c] === -1 || tryAssign(owner[c]!, seen)) { owner[c] = e; return true }
    }
    return false
  }
  for (let e = 0; e < ne; e++) tryAssign(e, new Array<boolean>(nc).fill(false))
  return owner.map((e, c) => ({ expected: e, call: c })).filter(x => x.expected >= 0)
}

/** Forbidden hits: every (spec, call) pair where a call matches a forbidden spec. */
export function forbiddenHits(forbidden: EvalActionSpec[], calls: EvalToolCall[]): Array<{ forbidden: number; call: number }> {
  const out: Array<{ forbidden: number; call: number }> = []
  forbidden.forEach((spec, f) => {
    const p = compile(spec)
    calls.forEach((call, c) => { if (p(call)) out.push({ forbidden: f, call: c }) })
  })
  return out
}

/** expected_content: every regex (case-insensitive) must find a match in the final text. */
export function contentMatches(patterns: string[], text: string): { pass: boolean; missing: string[] } {
  const missing = patterns.filter((p) => {
    try { return !new RegExp(p, 'i').test(text) } catch { return true }
  })
  return { pass: missing.length === 0, missing }
}
