import type { DocumentDTO } from '../../../shared/types/documents'
import { outline, clip } from '../documents/edit-ops'

/**
 * What a document write answers with.
 *
 * Deliberately body-free. Echoing the document back was a correctness bug, not just a cost
 * one: on a large doc the response exceeded the MCP host's tool-result cap, so a write that
 * had already committed reached the agent as an error — which it would then either retry
 * (double-applying, or failing on a now-stale old_string) or report as failed work.
 *
 * `hash` is the stored sha256 of the new content, so a caller can compare it against a local
 * copy without re-reading the body.
 */
export interface DocReceipt {
  ok: true
  id: string
  path: string
  title: string | null
  project: string | null
  type: string | null
  tags: string[]
  updatedAt: string
  hash: string | null
  bytes: { before: number, after: number }
  /** Occurrences rewritten — only meaningful for find/replace edits. */
  replacements?: number
}

/**
 * A document write that found no row to write to — either the id was wrong, or the row was
 * deleted between the read and the write landing (updateDoc/moveDoc then resolve null).
 * Typed like the other write failures so a caller can branch on `error` rather than on prose.
 */
export const docNotFound = (id: string) =>
  ({ ok: false as const, error: 'not_found' as const, message: 'document not found', id })

/**
 * A path-addressed miss (`sync_document` called with `path` and no `id`, matching no live doc)
 * — probe or a target lookup that comes up empty. Deliberately a SEPARATE shape from
 * `docNotFound`: that one's `id` field is documented as the file's `mymind_id`, and an agent
 * following the sync workflow writes whatever comes back there straight into frontmatter. Put a
 * path in that field and a path-addressed miss would poison the file with a path where a UUID
 * belongs. Reports the path in its own field instead, with no `id` at all.
 */
export const docNotFoundAtPath = (path: string) =>
  ({ ok: false as const, error: 'not_found' as const, message: 'document not found', path })

/** Body-free receipt for a document write. `before` is the pre-write byte length (0 for a create). */
export function docReceipt(
  doc: DocumentDTO,
  opts: { before: number, replacements?: number }
): DocReceipt {
  return {
    ok: true,
    id: doc.id,
    path: doc.path,
    title: doc.title,
    project: doc.project,
    type: doc.type,
    tags: doc.tags ?? [],
    updatedAt: doc.updatedAt,
    hash: doc.contentHash ?? null,
    bytes: { before: opts.before, after: (doc.content ?? '').length },
    ...(opts.replacements === undefined ? {} : { replacements: opts.replacements })
  }
}

/**
 * Why a sync refused to write. Deliberately body-free: enough for the agent to decide whether
 * to inspect, without pulling the document and re-creating the overflow receipts prevent.
 */
export function divergenceReport(
  error: 'adopt_conflict' | 'hash_mismatch' | 'expected_hash_required',
  server: DocumentDTO,
  localContent: string
) {
  const body = server.content ?? ''
  return {
    ok: false as const,
    error,
    id: server.id,
    server: {
      hash: server.contentHash,
      bytes: body.length,
      updatedAt: server.updatedAt,
      // Slice BEFORE map — a document with far more than 25 headings shouldn't pay to build
      // (and clip) text for the ones that get thrown away. Each surviving heading's text is
      // clipped (same 200-char cap as edit-ops' candidate lines) so a single pathological
      // heading — e.g. a giant one-line blob mistaken for a heading — can't reinflate the
      // "body-free" refusal payload back toward document size (a measured pathological case
      // hit ~200 KB before this cap).
      headings: outline(body).slice(0, 25).map(h => clip(h.text))
    },
    local: { bytes: localContent.length },
    hint: 'inspect with read_document/grep_document, then re-call with force:true (or sync with the server hash as expected_hash)'
  }
}
