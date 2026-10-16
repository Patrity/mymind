// Cycle 86: pure display helpers for artifacts (list/detail pages and the chat card).

/** The artifact iframe's sandbox. Deliberately NO allow-same-origin: artifact JS must stay in an opaque origin. */
export const ARTIFACT_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads'

export interface PublishedArtifact {
  id: string
  slug: string
  title: string
  url: string
  isPublic: boolean
  version: number
}

/** The artifact a publish_artifact / edit_artifact call produced, or null for anything else. */
export function publishedArtifact(toolName: string, value: unknown): PublishedArtifact | null {
  if (toolName !== 'publish_artifact' && toolName !== 'edit_artifact') return null
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.ok !== true) return null
  if (typeof v.id !== 'string' || typeof v.slug !== 'string' || typeof v.url !== 'string') return null
  return {
    id: v.id,
    slug: v.slug,
    title: typeof v.title === 'string' && v.title ? v.title : v.slug,
    url: v.url,
    isPublic: v.isPublic === true,
    version: typeof v.version === 'number' ? v.version : 1
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export interface ArtifactFormFields { title: string, description: string, slug: string }
export type ArtifactFormSync = ArtifactFormFields & { id: string }

/** The detail form's live-refetch rule: the fields to put in the form (and remember as synced), or null to
 *  keep the user's unsaved typing. Untouched = the form still equals what we last synced OR already equals
 *  the incoming artifact (after a save, the refetch brings back exactly what was typed). */
export function formSyncFor(
  form: ArtifactFormFields,
  synced: ArtifactFormSync | null,
  incoming: { id: string, title: string, description: string | null, slug: string }
): ArtifactFormSync | null {
  const next: ArtifactFormSync = { id: incoming.id, title: incoming.title, description: incoming.description ?? '', slug: incoming.slug }
  const same = (x: ArtifactFormFields) => form.title === x.title && form.description === x.description && form.slug === x.slug
  if (!synced || synced.id !== incoming.id || same(synced) || same(next)) return next
  return null
}
