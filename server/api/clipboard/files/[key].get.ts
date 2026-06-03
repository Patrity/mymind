import { eq } from 'drizzle-orm'
import { useDb } from '../../../db'
import { clipAttachments } from '../../../db/schema'
import { storage } from '../../../utils/storage'

// Allowlist of MIME types that are safe to serve with their declared content-type.
// Anything not on this list is forced to application/octet-stream to prevent
// stored-XSS via SVG/HTML files executed in-origin.
const ALLOWED_INLINE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'text/plain',
  'video/mp4',
  'video/webm'
])

// Mimes that should be served inline (rendered in browser, not downloaded).
// Must be a subset of ALLOWED_INLINE_MIMES.
function isInline(mime: string): boolean {
  return (
    mime.startsWith('image/') ||
    mime === 'application/pdf' ||
    mime.startsWith('video/')
  ) && ALLOWED_INLINE_MIMES.has(mime)
}

export default defineEventHandler(async (event) => {
  const key = getRouterParam(event, 'key')!

  // FIX 1a: Validate key shape — storage keys are sha256 hex (64 lower-case hex chars).
  // This blocks path traversal including ../, URL-encoded variants, etc.
  if (!/^[a-f0-9]{64}$/.test(key)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid file key' })
  }

  // FIX 1b: Require a matching attachment row before touching storage.
  // This prevents serving arbitrary objects that happen to exist in the bucket.
  const [att] = await useDb()
    .select({
      mime: clipAttachments.mime,
      originalName: clipAttachments.originalName
    })
    .from(clipAttachments)
    .where(eq(clipAttachments.storageKey, key))
    .limit(1)

  if (!att) {
    throw createError({ statusCode: 404, statusMessage: 'File not found' })
  }

  const { stream } = await storage().get(key).catch(() => {
    throw createError({ statusCode: 404, statusMessage: 'File not found' })
  })

  // FIX 2: Safe content-type — never trust the stored MIME directly.
  // Only serve known-safe types as-is; everything else becomes octet-stream.
  const storedMime = att.mime ?? ''
  const safeContentType = ALLOWED_INLINE_MIMES.has(storedMime)
    ? storedMime
    : 'application/octet-stream'

  // FIX 2: Content-Disposition — inline only for allowlisted image/pdf/video;
  // attachment (with filename) for everything else so HTML/SVG download instead
  // of executing in-origin.
  const disposition = isInline(safeContentType)
    ? 'inline'
    : att.originalName
      ? `attachment; filename="${att.originalName.replace(/"/g, '\\"')}"`
      : 'attachment'

  setResponseHeaders(event, {
    'content-type': safeContentType,
    'content-disposition': disposition,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=3600'
  })

  return sendStream(event, stream)
})
