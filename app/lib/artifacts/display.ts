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
