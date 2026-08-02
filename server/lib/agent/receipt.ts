import type { DocumentDTO } from '../../../shared/types/documents'

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
