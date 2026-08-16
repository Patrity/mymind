import type { TriageAction, TriageKind, TriageProposal } from '../../../shared/types/triage'
import { chat } from './chat'
import type { ProjectCandidate } from './enrich'

const KINDS = new Set<TriageKind>(['task', 'note', 'memory', 'append'])
const MAX_SECONDARY = 2

function clamp01(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
}

function parseAction(v: unknown): TriageAction | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.kind !== 'string' || !KINDS.has(o.kind as TriageKind)) return null
  const str = (k: string) => (typeof o[k] === 'string' ? o[k] as string : undefined)
  return {
    kind: o.kind as TriageKind,
    confidence: clamp01(o.confidence),
    title: str('title'),
    project: (typeof o.project === 'string' || o.project === null) ? o.project as string | null : undefined,
    priority: (o.priority === 'low' || o.priority === 'medium' || o.priority === 'high') ? o.priority : undefined,
    dueDate: (typeof o.dueDate === 'string' || o.dueDate === null) ? o.dueDate as string | null : undefined,
    scope: (o.scope === 'user' || o.scope === 'agent' || o.scope === 'world') ? o.scope : undefined,
    content: str('content'),
    tags: Array.isArray(o.tags) && o.tags.every(t => typeof t === 'string') ? o.tags as string[] : undefined,
    path: str('path')
    // targetDocId is intentionally NOT read from the model — the actuator resolves it.
  }
}

/** Mirrors parseProposal in ./enrich.ts: strip fences, brace-match, validate, null on failure. */
export function parseTriage(raw: string): TriageProposal | null {
  if (!raw || !raw.trim()) return null
  try {
    const text = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim()
    const start = text.indexOf('{')
    if (start === -1) return null
    let depth = 0
    let end = -1
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end === -1) return null

    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>

    const primary = parseAction(obj.primary)
    if (!primary) return null

    const secondary = (Array.isArray(obj.secondary) ? obj.secondary : [])
      .map(parseAction)
      .filter((a): a is TriageAction => a !== null)
      .slice(0, MAX_SECONDARY)

    return {
      primary,
      secondary,
      reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : ''
    }
  } catch {
    return null
  }
}

const TRIAGE_SYSTEM_PROMPT = `You triage a single captured note in a personal knowledge base and decide WHERE it belongs. Reply with STRICT JSON only, no prose.

Choose a "kind" for the primary action:
- "task"   — the note asks for something to be DONE. Set title (imperative, concise), priority (low|medium|high), and dueDate (ISO date) only if the note states one.
- "note"   — the note is reference material worth keeping as a document. Set title, and set path to a NEW destination path that moves it out of /input. The path MUST include a new, human-readable filename (kebab-case, .md) — never reuse the incoming random filename.
- "memory" — a durable fact, preference, or gotcha worth recalling in future sessions. Set content to one self-contained sentence and scope to user|agent|world.
- "append" — the note adds to a topic an existing document already covers. Set content to the text to append. Do NOT guess a target document; it is resolved separately.

Also set "confidence" (0..1) on every action: how sure you are that this is the right destination. Be honest — a low score routes to a human instead of acting.

If the note carries a second, genuinely distinct intent (for example an action AND a durable fact), add it to "secondary" (at most 2). If it does not, return an empty array.

Shape:
{"primary":{"kind":"...","confidence":0.0,...},"secondary":[],"reasoning":"one sentence"}`

export function buildTriageMessages(
  doc: { path: string, content: string },
  projects: ProjectCandidate[]
): Array<{ role: 'system' | 'user', content: string }> {
  let system = TRIAGE_SYSTEM_PROMPT

  if (projects.length > 0) {
    const list = projects.map(p => `  ${p.slug} — ${p.name} — ${p.description}`).join('\n')
    system += `\n\nAvailable projects (slug — name — description):\n${list}\n\nSet "project" to the single best-matching SLUG from this list, or null if none clearly fits. For a "note", if you chose a project, path must be /projects/<slug>/<new-filename>.md.`
  } else {
    system += `\n\nNo projects are available. Set project to null.`
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content: `Path: ${doc.path}\n\nContent:\n${doc.content.slice(0, 6000)}` }
  ]
}

/** One bulk-model call. Returns null on any AI or parse failure — the caller decides what that means. */
export async function classify(
  doc: { path: string, content: string },
  projects: ProjectCandidate[]
): Promise<TriageProposal | null> {
  try {
    // 'bulk' = the no-think model. The reasoning alias emits <think>/reasoning_content
    // and returns null content under the token cap, which chat() throws on.
    const raw = await chat('bulk', buildTriageMessages(doc, projects), { temperature: 0.1 })
    return parseTriage(raw)
  } catch (err) {
    console.warn('[triage] classify failed:', err)
    return null
  }
}
