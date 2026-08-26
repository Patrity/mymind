export type ViewMode = 'edit' | 'preview' | 'split'

/**
 * The view mode actually used for a document, given the user's stored preference.
 *
 * Pure and per-document by design: the caller keeps the cookie untouched, so a preference
 * of `preview` survives opening an empty note and comes back for the next document that
 * has content. `split` is deliberately left alone — it still shows a live editor pane.
 */
export function resolveViewMode(
  stored: ViewMode,
  doc: { content: string, isMarkdown: boolean }
): ViewMode {
  if (!doc.isMarkdown) return 'edit'
  if (stored === 'preview' && doc.content.trim() === '') return 'edit'
  return stored
}
