import { and, isNull, ilike, or } from 'drizzle-orm'
import { useDb } from '../db'
import { tasks, projects } from '../db/schema'
import { searchDocs, searchPassages } from './documents'
import { searchMemories } from './memory'
import { searchImages } from './images'
import { searchSessions, searchMessages } from './session-search'
import { getSearchConfig } from '../lib/search/config'
import { makeSnippet } from '../lib/search/snippet'
import { rankCandidates, type Candidate } from '../lib/search/rank'
import { rerank } from '../lib/ai/rerank'
import { resolveChain } from '../lib/ai/registry/resolve'
import type { SearchResults } from '../../shared/types/search'

const RERANK_TEXT_MAX = 512
const clip = (s: string) => (s.length > RERANK_TEXT_MAX ? s.slice(0, RERANK_TEXT_MAX) : s)
const includesCI = (haystack: string, q: string) => haystack.toLowerCase().includes(q.toLowerCase())

export async function searchAll(q: string): Promise<SearchResults> {
  if (!q.trim()) return { hits: [], reranked: false }
  const cfg = await getSearchConfig()
  const K = cfg.candidatesPerLane

  const [docC, memC, imgC, taskC, projC, sessC, msgC] = await Promise.all([
    // documents — best chunk passage as snippet + rerank text
    (async (): Promise<Candidate[]> => {
      try {
        const [docs, passages] = await Promise.all([searchDocs(q), searchPassages(q, { limit: K })])
        const bestPassage = new Map<string, string>()
        for (const p of passages) if (!bestPassage.has(p.sourceId)) bestPassage.set(p.sourceId, p.content)
        return docs.slice(0, K).map((d, i): Candidate => {
          const body = bestPassage.get(d.id) ?? d.content
          return {
            type: 'document', id: d.id, title: d.title || d.path, to: '/documents?doc=' + d.id,
            icon: 'i-lucide-file-text', meta: d.path,
            snippet: makeSnippet(body, q), rerankText: clip(`${d.title ?? ''}\n${body}`),
            lexicalExact: includesCI(`${d.title ?? ''} ${d.content}`, q), rrfRank: i
          }
        })
      } catch { return [] }
    })(),

    // memories
    (async (): Promise<Candidate[]> => {
      try {
        const mems = await searchMemories(q, { limit: K })
        return mems.map((m, i): Candidate => ({
          type: 'memory', id: m.id, title: makeSnippet(m.content, q, 80), to: '/memories',
          icon: 'i-lucide-brain', meta: m.scope,
          snippet: makeSnippet(m.content, q), rerankText: clip(m.content),
          lexicalExact: includesCI(m.content, q), rrfRank: i
        }))
      } catch { return [] }
    })(),

    // images — summary + OCR text
    (async (): Promise<Candidate[]> => {
      try {
        const imgs = await searchImages(q)
        return imgs.slice(0, K).map((im, i): Candidate => {
          const body = `${im.summary ?? ''}\n${im.ocrText ?? ''}`.trim()
          const tagStr = (im.tags ?? []).join(', ')
          return {
            type: 'image', id: im.id, title: tagStr || im.originalName || 'Image', to: '/gallery',
            icon: 'i-lucide-image', meta: null,
            snippet: makeSnippet(body || tagStr, q), rerankText: clip(body || tagStr),
            lexicalExact: includesCI(`${body} ${tagStr}`, q), rrfRank: i
          }
        })
      } catch { return [] }
    })(),

    // tasks — ILIKE (always an exact lexical match)
    (async (): Promise<Candidate[]> => {
      try {
        const db = useDb()
        const pattern = `%${q}%`
        const rows = await db.select().from(tasks)
          .where(and(isNull(tasks.deletedAt), or(ilike(tasks.title, pattern), ilike(tasks.description, pattern))))
          .limit(K)
        return rows.map((t, i): Candidate => ({
          type: 'task', id: t.id, title: t.title, to: '/tasks', icon: 'i-lucide-square-kanban', meta: t.status,
          snippet: makeSnippet(t.description || t.title, q), rerankText: clip(`${t.title}\n${t.description ?? ''}`),
          lexicalExact: true, rrfRank: i
        }))
      } catch { return [] }
    })(),

    // projects — ILIKE (always exact)
    (async (): Promise<Candidate[]> => {
      try {
        const db = useDb()
        const pattern = `%${q}%`
        const rows = await db.select().from(projects)
          .where(or(ilike(projects.name, pattern), ilike(projects.slug, pattern)))
          .limit(K)
        return rows.map((p, i): Candidate => ({
          type: 'project', id: p.slug, title: p.name, to: '/projects', icon: 'i-lucide-folder-kanban', meta: p.slug,
          snippet: null, rerankText: clip(`${p.name} ${p.slug}`), lexicalExact: true, rrfRank: i
        }))
      } catch { return [] }
    })(),

    // sessions
    (async (): Promise<Candidate[]> => {
      try {
        const sess = await searchSessions(q, K)
        return sess.map((s, i): Candidate => ({
          type: 'session', id: s.id, title: s.title, to: s.to, icon: 'i-lucide-history', meta: s.project,
          snippet: makeSnippet(s.snippet, q), rerankText: clip(`${s.title}\n${s.snippet}`),
          lexicalExact: includesCI(`${s.title} ${s.snippet}`, q), rrfRank: i
        }))
      } catch { return [] }
    })(),

    // messages
    (async (): Promise<Candidate[]> => {
      try {
        const msgs = await searchMessages(q, K)
        return msgs.map((m, i): Candidate => ({
          type: 'message', id: m.id, title: makeSnippet(m.snippet, q, 80), to: m.to,
          icon: 'i-lucide-message-circle', meta: m.role,
          snippet: makeSnippet(m.snippet, q), rerankText: clip(m.snippet),
          lexicalExact: includesCI(m.snippet, q), rrfRank: i
        }))
      } catch { return [] }
    })()
  ])

  const pool = [...docC, ...memC, ...imgC, ...taskC, ...projC, ...sessC, ...msgC].slice(0, cfg.maxCandidates)
  if (pool.length === 0) return { hits: [], reranked: false }

  // Single cross-type rerank → raw scores (only if a 'rerank' model is assigned)
  let rerankScores: Map<string, number> | null = null
  let rerankModel: { baseURL: string | null; apiKey: string | null; modelId: string } | null = null
  try {
    const [m] = await resolveChain('rerank')
    if (m?.baseURL) rerankModel = m
  } catch { rerankModel = null }  // AiNotConfiguredError → reranker off

  if (rerankModel?.baseURL) {
    try {
      const docs = pool.map(c => ({ id: `${c.type}:${c.id}`, text: c.rerankText }))
      const results = await rerank(q, docs, rerankModel.baseURL.replace(/\/$/, ''), rerankModel.apiKey ?? '', rerankModel.modelId)
      rerankScores = results.length ? new Map(results.map(r => [r.id, r.score])) : null
    } catch (err) {
      console.warn('[searchAll] reranker failed, falling back to RRF order:', err)
      rerankScores = null
    }
  }

  const hits = rankCandidates(pool, rerankScores, { topK: cfg.rerankTopK, relBand: cfg.rerankRelBand })
  return { hits, reranked: rerankScores !== null }
}
