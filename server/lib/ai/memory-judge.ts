import { chat } from './chat'

export type Relation = 'duplicate' | 'refines' | 'contradicts' | 'unrelated'
export interface Verdict { existingId: string, relation: Relation, confidence: number, reasoning?: string }

const RELATIONS = new Set<Relation>(['duplicate', 'refines', 'contradicts', 'unrelated'])
const PROMPT = `You compare a NEW candidate memory against EXISTING memories that are semantically near it. For each existing memory, classify its relationship to the NEW one:
- "duplicate": same fact, no new information.
- "refines": the NEW memory is a more current/correct/complete version that should SUPERSEDE the existing one.
- "contradicts": the NEW memory conflicts with the existing one (both can't be true).
- "unrelated": different facts that happen to be near.
Output STRICT JSON only: {"verdicts":[{"existingId":"<id>","relation":"duplicate|refines|contradicts|unrelated","confidence":0.0-1.0,"reasoning":"<short>"}]}. Be conservative: default to "unrelated" unless clear.`

export function parseJudgement(raw: string, validIds: string[]): Verdict[] {
  const valid = new Set(validIds)
  const s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let obj: unknown = null
  try { obj = JSON.parse(s) } catch { const m = s.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]) } catch { /* */ } } }
  const arr = (obj && typeof obj === 'object' && Array.isArray((obj as Record<string, unknown>).verdicts))
    ? (obj as Record<string, unknown>).verdicts as unknown[] : []
  return arr.flatMap((v): Verdict[] => {
    if (!v || typeof v !== 'object') return []
    const o = v as Record<string, unknown>
    const existingId = typeof o.existingId === 'string' ? o.existingId : ''
    if (!valid.has(existingId)) return []
    const relation: Relation = (typeof o.relation === 'string' && RELATIONS.has(o.relation as Relation)) ? o.relation as Relation : 'unrelated'
    const confidence = typeof o.confidence === 'number' ? Math.min(1, Math.max(0, o.confidence)) : 0.5
    const reasoning = typeof o.reasoning === 'string' ? o.reasoning.slice(0, 400) : undefined
    return [{ existingId, relation, confidence, ...(reasoning ? { reasoning } : {}) }]
  })
}

/** LLM relationship classification. Returns [] on any failure (caller falls back to plain dedup). */
export async function judgeRelations(candidate: string, near: { id: string, content: string }[]): Promise<Verdict[]> {
  if (!near.length) return []
  const user = `NEW:\n${candidate}\n\nEXISTING:\n${near.map(n => `[${n.id}] ${n.content}`).join('\n')}`
  try {
    // 'bulk' = no-think model: a capped, single-shot JSON judgment. The reasoning
    // alias emits <think>/reasoning_content and returns null content under the token
    // cap, which chat() throws on (rescued only by failover).
    const raw = await chat('bulk', [{ role: 'system', content: PROMPT }, { role: 'user', content: user }], { temperature: 0.1, maxTokens: 800 })
    return parseJudgement(raw, near.map(n => n.id))
  } catch { return [] }
}
