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
import { createDoc } from './documents'
import { triageCapture } from './triage'
import { publishChange } from '../utils/live-bus'
import { slugify } from '../../shared/utils/slugify'
import type { DocCandidate } from '../lib/memory/extract-v3'

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
 * Never throws — enrichment must never fail because a doc candidate couldn't be filed. A null
 * return means the capture itself failed (createDoc threw for another reason); the
 * fire-and-forget triageCapture call below has its own, separately-logged failure path.
 */
export async function fileDocCandidate(
  c: DocCandidate,
  src: { sessionId?: string, conversationId?: string }
): Promise<{ docId: string } | null> {
  const logCtx = `session=${src.sessionId ?? '-'} conversation=${src.conversationId ?? '-'}`
  try {
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
