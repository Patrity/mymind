/**
 * Files doc-worthy memory-extraction detail (DocCandidate, from server/lib/memory/extract-v3)
 * as a /input/ capture, then routes it through the SAME triage pipeline every other capture
 * goes through (the quick_capture tool, POST /api/capture/note). See memory-enrich.ts's
 * routeDocCandidates — the only caller — which fires this once per candidate, fire-and-forget,
 * after extraction.
 *
 * The mirror guard (no append into a repo-mirrored wiki/handover doc) lives in triage itself,
 * via isRepoMirrorPath (server/lib/documents/mirror.ts), and applies to EVERY triage append.
 */
import { nanoid } from 'nanoid'
import { and, eq, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { toolEvents } from '../db/schema'
import { createDoc } from './documents'
import { nearestDocument, triageCapture } from './triage'
import { publishChange } from '../utils/live-bus'
import { slugify } from '../../shared/utils/slugify'
import type { DocCandidate } from '../lib/memory/extract-v3'

/**
 * A candidate whose nearest existing document is at least this similar is already documented
 * and is not filed. Calibrated on prod 2026-10-02: the two duplicate captures (a re-told cycle 77
 * handover, a "runbook" for that night's deploy) scored 0.78 / 0.71 against their source docs;
 * the six genuinely new ones scored ≤ 0.59.
 */
export const DOC_CANDIDATE_DUP_FLOOR = 0.65

export type FileDocCandidateResult =
  | { docId: string }
  | { skipped: 'duplicate', nearestPath: string, similarity: number }
  | null

/** A repo documentation file: the project's wiki, handovers, or superpowers specs/plans. */
export const REPO_DOC_PATH_RE = /(^|\/)docs\/(wiki|handovers|superpowers\/(specs|plans))\//
/** MyMind document-writing MCP tools. */
export const MYMIND_DOC_TOOL_RE = /^mcp__mymind__(save_document|sync_document|update_document|edit_document|edit_section)$/
const FILE_WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit']

/** Does this tool call write project documentation? Pure — mirrors sessionWroteDocs's SQL. */
export function isDocWriteToolCall(toolName: string, args: unknown): boolean {
  if (MYMIND_DOC_TOOL_RE.test(toolName)) return true
  const filePath = (args as { file_path?: unknown } | null)?.file_path
  return FILE_WRITE_TOOLS.includes(toolName) && typeof filePath === 'string' && REPO_DOC_PATH_RE.test(filePath)
}

/**
 * Did this session write project documentation itself (a repo wiki/handover/spec/plan, or a
 * MyMind document)? Then its doc-worthy detail is already documented — the doc candidates
 * extracted from it are re-tellings of that writing, and filing them only creates second copies.
 */
export async function sessionWroteDocs(sessionId: string): Promise<boolean> {
  const [hit] = await useDb().select({ id: toolEvents.id }).from(toolEvents).where(and(
    eq(toolEvents.sessionId, sessionId),
    sql`(${toolEvents.toolName} ~ ${MYMIND_DOC_TOOL_RE.source}
      or (${toolEvents.toolName} in ('Write', 'Edit', 'MultiEdit') and ${toolEvents.args}->>'file_path' ~ ${REPO_DOC_PATH_RE.source}))`
  )).limit(1)
  return !!hit
}

/** True for a Postgres unique-violation (23505), from either node-postgres shape. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string, cause?: { code?: string } } | null
  return e?.code === '23505' || e?.cause?.code === '23505'
}

/** The capture's title: the first line of the candidate's text (a hint like "handover" is too generic). */
function captureTitle(text: string): string | null {
  const line = text.split('\n').map(l => l.trim()).find(Boolean) ?? ''
  return line ? (line.length > 80 ? `${line.slice(0, 79)}…` : line) : null
}

/**
 * Turn one doc-worthy extraction into a /input/ capture and hand it to triage, exactly like a
 * user's own quick_capture/POST /api/capture/note — reusing that path (not duplicating its
 * slug logic, not inventing a separate doc-filing pipeline) means a doc candidate gets the SAME
 * downstream treatment (project classification, task/note/memory/append routing, the mirror
 * guard) as anything Tony captures by hand.
 *
 * Slug derivation mirrors quick_capture's (server/lib/agent/tools.ts): a hint-derived slug when
 * there's a targetDocHint to work with, else a random one — targetDocHint is the closest thing
 * a DocCandidate has to quick_capture's optional title. Hints are generic ("handover") and an
 * untriaged capture stays live in /input/ until Tony acts, so the hint slug often collides
 * (documents_path_live_uidx): on a collision the slug gets a short random suffix and the capture
 * is filed anyway — never dropped (final review I3).
 *
 * Never throws — enrichment must never fail because a doc candidate couldn't be filed. A
 * `skipped: 'duplicate'` return means an existing document already covers it (see
 * DOC_CANDIDATE_DUP_FLOOR). A null return means the capture itself failed (createDoc threw for another reason); the
 * fire-and-forget triageCapture call below has its own, separately-logged failure path.
 */
export async function fileDocCandidate(
  c: DocCandidate,
  src: { sessionId?: string, conversationId?: string }
): Promise<FileDocCandidateResult> {
  const logCtx = `session=${src.sessionId ?? '-'} conversation=${src.conversationId ?? '-'}`
  try {
    // Duplicate guard: a candidate that restates a document we already have (very often the
    // session's own handover/wiki page, mirrored from the repo) is not filed. A failed lookup
    // (embeddings down) files it anyway — triage and /review are the backstop.
    const nearest = await nearestDocument(c.text).catch((err) => {
      console.warn(`[memory-doc-candidates] duplicate check failed (${logCtx}), filing anyway:`, err)
      return null
    })
    if (nearest && nearest.similarity >= DOC_CANDIDATE_DUP_FLOOR) {
      console.info(`[memory-doc-candidates] skipped a duplicate of ${nearest.path} (similarity ${nearest.similarity.toFixed(2)}, ${logCtx})`)
      return { skipped: 'duplicate', nearestPath: nearest.path, similarity: nearest.similarity }
    }

    const slug = c.targetDocHint
      ? (slugify(c.targetDocHint).slice(0, 64) || nanoid(8))
      : nanoid(10)
    const body = `${c.text}\n\n— From memory extraction (project: ${c.project ?? '(no project)'}; suggested doc: ${c.targetDocHint ?? 'none'})`

    const title = captureTitle(c.text)
    const doc = await createDoc({ path: `/input/${slug}.md`, title, content: body })
      .catch((err) => {
        if (!isUniqueViolation(err)) throw err
        return createDoc({ path: `/input/${slug.slice(0, 57)}-${nanoid(6)}.md`, title, content: body })
      })
    publishChange({ resource: 'document', action: 'created', id: doc.id })

    // Fire-and-forget, same convention as quick_capture / POST /api/capture/note: filing must
    // never block extraction, and a triage failure must never surface as an unhandled rejection.
    void triageCapture(doc.id).catch(err => console.warn(`[memory-doc-candidates] triage failed for ${doc.id} (${logCtx}):`, err))

    return { docId: doc.id }
  } catch (err) {
    console.warn(`[memory-doc-candidates] fileDocCandidate failed (${logCtx}):`, err)
    return null
  }
}
