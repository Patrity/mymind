/**
 * extract-v3 — the single definition of "a good memory" (cycle 77).
 *
 * Used by enrichment to extract memories from a transcript, and (Task 3) by the audit that
 * re-judges an existing memory against the same criteria. Bump EXTRACT_PROMPT_VERSION whenever
 * the criteria change: every memory created by this prompt is stamped with it
 * (`memories.extract_prompt_version`), so scores can be compared per prompt generation.
 */
import { chat } from '../ai/chat'
import { parseExtractV3, type DocCandidate, type MemoryCandidate } from '../ai/memory-extract'

export { parseExtractV3, type DocCandidate }

export const EXTRACT_PROMPT_VERSION = 'extract-v3'

/**
 * The durability criteria, shared verbatim by the extraction prompt and the audit prompt so the
 * two can never disagree about what qualifies.
 */
export const EXTRACT_V3_CRITERIA = `DURABLE FACTS ONLY. Extract only facts that will still be true and useful in six months, independent of the session they came from. The test for every candidate: "Will this still be true AND useful in six months?" If not, DROP it.

GOOD MEMORIES (high signal): durable architecture/design decisions stated as one fact + their rationale; stable project conventions, constraints, and invariants; non-obvious gotchas/footguns and how to avoid them; durable service/host/config facts; durable facts about Tony (preferences, identity, how he likes to work); non-obvious reusable facts about external systems (libraries/APIs/Postgres).

REJECT — time-sensitive or likely stale (the most common mistakes):
- Pending or planned work: "has a pending Plan B", "next we will…", "the plan is to…", upcoming migrations or features.
- The state of in-progress work: what is half-done, which tasks/phases are complete, what was "just shipped/built/fixed", build/CI status.
- Versions, counts, prices, or dates expected to change: test counts ("98 tests pass"), coverage, row counts, spend, in-flux version numbers, scheduled dates.
- Anything phrased "currently / now / today / the current X".
- TODOs and steps someone must take ("Tony needs to rotate the key", "run the backfill after deploy").
- In-progress bug details that get fixed within the session. (A durable LESSON from the fix can qualify; the bug-of-the-moment does not.)
- Anything about the AI's OWN process or tooling: skills (e.g. "superpowers:X", "the debugging skill"), the agent's workflow, "Tony uses the X skill", the agent's own review/commit/TDD conventions.
- Session narration: "Tony asked…", "we explored…", "the task is…", "this session…".
- Volatile specifics that churn: exact file paths, line numbers, commit SHAs.

ROUTE, DON'T EXTRACT — belongs in a document, not a memory: architecture detail (how a system's parts fit together), spec or handover content (what shipped, what was deferred, design rationale across many points), and multi-step how-tos/procedures. These are NOT memories.

EACH MEMORY MUST BE: a single atomic fact, present tense ("X is Y", not "we decided/shipped X"), <=240 chars; self-contained — it names the project or thing it is about; free of "this/that/it" references back to the transcript.

CONFIDENCE = DURABILITY + reusability, NOT how clearly you observed it. Anchors: 0.9 = a stable fact about Tony or the system; 0.7 = durable but could change this year; 0.5 = likely to change within weeks; below 0.4 = do not extract.

SCOPES: 'user' = durable facts about Tony (be conservative, never fabricate). 'agent' = the project/environment (most common). 'world' = external systems (only non-obvious, reusable).`

export const EXTRACT_SYSTEM_PROMPT = `You extract a SMALL number of DURABLE, HIGH-SIGNAL memories from an AI work-session transcript, for a long-term memory store serving Tony, a software engineer. Be RUTHLESSLY selective.

${EXTRACT_V3_CRITERIA}

Most transcripts yield 0-3 memories. An empty list is a correct answer, and a common one.

Doc-worthy material goes in "doc_candidates" instead: { "text": a self-contained summary of the detail worth documenting, "project": the project it belongs to or null, "targetDocHint": the kind/name of doc it belongs in (e.g. "wiki: ingest pipeline", "handover", "runbook: deploy") or null }. At most 5; usually none.

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
