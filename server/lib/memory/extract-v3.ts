/**
 * extract-v3 — the single definition of "a good memory" (cycle 77).
 *
 * Used by enrichment to extract memories from a transcript, and by the audit (below) that
 * re-judges an existing memory against the same criteria. Bump EXTRACT_PROMPT_VERSION whenever
 * the criteria change: every memory created by this prompt is stamped with it
 * (`memories.extract_prompt_version`), so scores can be compared per prompt generation.
 */
import { chat, chatWithModel, isRejectedRequestError, type ChatMessage } from '../ai/chat'
import { parseExtractV3, extractBalanced, type DocCandidate, type MemoryCandidate } from '../ai/memory-extract'
import type { AuditVerdict } from '../../../shared/types/memory'

export { parseExtractV3, type DocCandidate }

export const EXTRACT_PROMPT_VERSION = 'extract-v3'

/**
 * The durability criteria, shared verbatim by the extraction prompt and the audit prompt so the
 * two can never disagree about what qualifies.
 */
export const EXTRACT_V3_CRITERIA = `DURABLE FACTS ONLY. Extract only facts that will still be true and useful in six months, independent of the session they came from. The test for every candidate: "Will this still be true AND useful in six months?" If not, DROP it.

GOOD MEMORIES (high signal): durable architecture/design decisions stated as one fact + their rationale; stable project conventions, constraints, and invariants; non-obvious gotchas/footguns and how to avoid them; durable service/host/config facts and stable locations (which container runs prod, where backups live); durable facts about Tony (preferences, identity, how he likes to work); non-obvious reusable facts about external systems (libraries/APIs/Postgres).

REJECT — time-sensitive or likely stale (the most common mistakes):
- Pending or planned work: "has a pending Plan B", "next we will…", "the plan is to…", upcoming migrations or features.
- The state of in-progress work: what is half-done, which tasks/phases are complete, what was "just shipped/built/fixed", build/CI status.
- Versions, counts, prices, or dates expected to change: test counts ("98 tests pass"), coverage, row counts, spend, in-flux version numbers, scheduled dates.
- Anything phrased "currently / now / today / the current X".
- TODOs and steps someone must take ("Tony needs to rotate the key", "run the backfill after deploy").
- In-progress bug details that get fixed within the session. (A durable LESSON from the fix can qualify; the bug-of-the-moment does not.)
- Anything about the AI's OWN process or tooling: skills (e.g. "superpowers:X", "the debugging skill"), the agent's workflow, "Tony uses the X skill", the agent's own review/commit/TDD conventions.
- Session narration: "Tony asked…", "we explored…", "the task is…", "this session…".
- Volatile specifics that churn: source-file paths, temp/worktree/scratch paths, line numbers, commit SHAs. (Stable host and service locations are NOT volatile and can be memories.)

JUDGE THE FACT, NOT ITS WORDING. Reject only when the fact itself is a snapshot. A "from now on, always X" preference is a durable fact about Tony even though it says "now"; "we decided X because Y" is a durable decision even though it is past tense. Restate such facts in timeless present tense ("Tony uses pnpm for all projects", "MyMind stores X because Y").

ROUTE, DON'T EXTRACT — belongs in a document, not a memory: architecture detail (how a system's parts fit together), spec or handover content (what shipped, what was deferred, design rationale across many points), and multi-step how-tos/procedures. These are NOT memories.

EACH MEMORY MUST BE: a single atomic fact, present tense ("X is Y", not "we decided/shipped X"), <=240 chars; self-contained — it names the project or thing it is about; free of "this/that/it" references back to the transcript.

CONFIDENCE = DURABILITY + reusability, NOT how clearly you observed it. A precisely-observed fact that won't matter next month is LOW confidence. Anchors: 0.9 = a stable fact about Tony or the system; 0.7 = durable but could change this year; 0.5 = likely to change within weeks. Below 0.6 = do not extract.

SCOPES: 'user' = durable facts about Tony (be conservative, never fabricate). 'agent' = the project/environment (most common). 'world' = external systems (only non-obvious, reusable).`

export const EXTRACT_SYSTEM_PROMPT = `You extract a SMALL number of DURABLE, HIGH-SIGNAL memories from an AI work-session transcript, for a long-term memory store serving Tony, a software engineer. Be RUTHLESSLY selective.

${EXTRACT_V3_CRITERIA}

Most transcripts yield 0-3 memories. An empty list is a correct answer, and a common one.

Doc-worthy material goes in "doc_candidates" instead: { "text": a self-contained summary of the detail worth documenting, "project": the project it belongs to or null, "targetDocHint": the kind/name of doc it belongs in (e.g. "wiki: ingest pipeline", "handover", "runbook: deploy") or null }. At most 5; usually none. A transcript can yield both: keep the single durable rule as a memory and route the surrounding detail as a doc candidate.

For each memory: cite the transcript message ids that justify it (evidence_msg_ids), a short verbatim quote (<=240 chars), and one-line reasoning that states WHY it is durable (not just true).
Output STRICT JSON ONLY: {"memories":[{"scope":"user|agent|world","content":"...","tags":["kebab"],"confidence":0.0-1.0,"evidence_msg_ids":["..."],"quote":"...","reasoning":"..."}],"doc_candidates":[{"text":"...","project":"...|null","targetDocHint":"...|null"}]}. No prose.`

export interface ExtractV3Result { memories: MemoryCandidate[], docCandidates: DocCandidate[] }

/**
 * One extraction call. 'bulk' = no-think model: a capped, single-shot structured extraction.
 * The reasoning alias emits <think>/reasoning_content and returns null content under the token
 * cap, which chat() throws on (failover-rescued). maxTokens leaves room for doc_candidates.
 */
export async function extractV3(transcript: string, deps: { chatFn?: typeof chat } = {}): Promise<ExtractV3Result> {
  const chatFn = deps.chatFn ?? chat
  const raw = await chatFn(
    'bulk',
    [
      { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
      { role: 'user', content: transcript }
    ],
    { temperature: 0.2, maxTokens: 1600 }
  )
  return parseExtractV3(raw)
}

// ---------------------------------------------------------------------------
// The audit — re-judges an EXISTING memory against the extract-v3 criteria.
// ---------------------------------------------------------------------------

/**
 * Bump whenever the audit prompt changes; stamped per-row as `memories.audit_prompt_version`, and
 * a row stamped with an older version is re-selected (the backfill re-audits it).
 * audit-v2 (final review I4): point-in-time state → transient; judge durability, not plausibility.
 */
export const AUDIT_PROMPT_VERSION = 'audit-v2'

export const AUDIT_VERDICTS = ['keep', 'transient', 'redundant', 'wrong_scope', 'belongs_in_doc'] as const

export const AUDIT_SYSTEM_PROMPT = `You are re-auditing an EXISTING memory in a long-term memory store for Tony, a software engineer, against the SAME durability criteria used to extract it in the first place.

${EXTRACT_V3_CRITERIA}

You will be given one existing memory: its content, scope, project, and age in days. Ask: would this memory pass these criteria if extracted today, and how durable is it?

JUDGE DURABILITY, NOT PLAUSIBILITY. Being true, specific, well-reasoned or technically useful does NOT make a memory durable. The only question is: "Will this exact statement still be true AND worth reading in six months?" Most memories that fail record a STATE, not a rule.

POINT-IN-TIME STATE IS "transient", however confidently it is worded:
- the state of a project, plan, task, schedule or dataset: what it currently contains or lacks, how its dates/milestones/values currently fall, which logic "changed from X to Y", what is merged, deployed, pending or in a given phase;
- a known bug or defect in a system (bugs get fixed; only a general lesson outlives one);
- pinned versions and the current stack: "uses library X vN", "the migration uses package ^2", "runs model X on GPU Y", which release supports what — these change with the next upgrade;
- anything that is only true while the system stays exactly as it was the day it was written. The older the memory, the more likely such a snapshot is already stale.
A general rule, a stable invariant with its reason, a non-obvious gotcha about how an external system behaves, or a fact about Tony is "keep" even when it mentions a project, version or date in passing.

Verdicts:
- "keep": still passes the criteria — a durable rule/fact that will hold in six months.
- "transient": point-in-time state (above), or was true but has gone stale or passed its moment.
- "redundant": duplicates a more general fact that is better captured elsewhere.
- "wrong_scope": filed under the wrong scope (user/agent/world) for what it actually says.
- "belongs_in_doc": architecture/how-to/spec detail that should have been routed to a document, not kept as a memory.

"keep" (the number) is how likely the memory is to still be true and worth keeping in six months.

Output STRICT JSON ONLY: {"keep": 0.0-1.0, "verdict": "keep|transient|redundant|wrong_scope|belongs_in_doc", "reason": "one short sentence, <=200 chars"}. No prose.`

/** The chat messages for one audit call. */
export function auditMessages(m: { content: string, project: string | null, ageDays: number, scope: string }): ChatMessage[] {
  return [
    { role: 'system', content: AUDIT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Memory to audit:\nscope: ${m.scope}\nproject: ${m.project ?? 'none'}\nage: ${m.ageDays} day${m.ageDays === 1 ? '' : 's'}\ncontent: "${m.content}"`
    }
  ]
}

export type ParsedAudit =
  | { ok: true, keep: number, verdict: AuditVerdict, reason: string }
  | { ok: false, error: string }

/**
 * Tolerant JSON parse of an audit reply (fence/prose-tolerant, string-aware brace matching —
 * see `extractBalanced`). Never throws. `keep` is clamped to [0,1]; an unknown/missing verdict
 * or a non-numeric `keep` is a parse failure (ok:false) — those are the two fields the caller
 * acts on, so a bad reply there must count as a failure (bumps `audit_failures`) rather than
 * silently defaulting. `reason` is optional prose: missing/non-string becomes '', and any value
 * is trimmed to 200 chars.
 */
export function parseAudit(raw: string): ParsedAudit {
  if (!raw || !raw.trim()) return { ok: false, error: 'empty reply' }

  try {
    const text = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '')
    const start = text.indexOf('{')
    if (start === -1) return { ok: false, error: 'no JSON object found' }

    const jsonStr = extractBalanced(text, start, '{', '}')
    if (!jsonStr) return { ok: false, error: 'unbalanced JSON object' }

    const parsed = JSON.parse(jsonStr) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'not a JSON object' }
    }
    const obj = parsed as Record<string, unknown>

    const verdictRaw = obj.verdict
    if (typeof verdictRaw !== 'string' || !(AUDIT_VERDICTS as readonly string[]).includes(verdictRaw)) {
      return { ok: false, error: `unknown verdict: ${String(verdictRaw)}` }
    }

    const keepRaw = obj.keep
    if (typeof keepRaw !== 'number' || Number.isNaN(keepRaw)) {
      return { ok: false, error: 'missing or invalid keep' }
    }
    const keep = Math.min(1, Math.max(0, keepRaw))

    const reason = typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 200) : ''

    return { ok: true, keep, verdict: verdictRaw as AuditVerdict, reason }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'parse error' }
  }
}

/**
 * Audit one existing memory against the extract-v3 criteria. 'bulk' = same no-think chain the
 * extractor uses — see extractV3's comment on why (the reasoning alias's think-blocks blow the
 * token cap and chat() throws). Never throws. A thrown call (network, timeout, 429/5xx, failover
 * exhausted) comes back as ok:false with `transport: true`, so the caller can tell an
 * infrastructure outage (retry later, never counted against the row) from a bad reply (content
 * failure, counted toward `audit_failures`). When every chain member answered blank or refused
 * the request with a 4xx other than 401/403/408/429 (isRejectedRequestError), the failure is about
 * this memory, so it is a CONTENT failure (no transport flag) — otherwise a poison row would never
 * be capped and would trip the audit's breaker at the front of every batch (final review I1).
 *
 * `model` is the chain member that ANSWERED (chatWithModel), so `audit_model` records provenance
 * even when the call failed over off the chain head.
 */
export async function auditMemory(
  m: { content: string, project: string | null, ageDays: number, scope: string },
  deps: { chatFn?: typeof chatWithModel } = {}
): Promise<(ParsedAudit & { model?: string }) | { ok: false, error: string, transport: true }> {
  const chatFn = deps.chatFn ?? chatWithModel
  let reply: { text: string, model: string }
  try {
    reply = await chatFn('bulk', auditMessages(m), { temperature: 0, maxTokens: 300 })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    if (isRejectedRequestError(err)) return { ok: false, error }
    return { ok: false, error, transport: true }
  }
  const parsed = parseAudit(reply.text)
  return parsed.ok ? { ...parsed, model: reply.model } : parsed
}
