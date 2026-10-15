// Cycle 86 (spec §5): /artifact/<slug>/… — outside /api, so it does its own auth. All decisions are
// in @mymind/core/lib/artifacts/serve (unit-tested); this file only does IO.
import { decideArtifactRequest, artifactHeaders, parseArtifactUrl } from '@mymind/core/lib/artifacts/serve'
import { signViewToken, verifyViewToken } from '@mymind/core/lib/artifacts/token'
import { findServable } from '@mymind/core/lib/artifacts/service'
import { storage } from '@mymind/core/utils/storage'

export default defineEventHandler(async (event) => {
  const url = getRequestURL(event)
  const method = event.method
  // Headers go on EVERY response, including 404, 403, 500 and redirects (spec §5).
  const plain = (status: number, body: string, isPublic = false) => {
    setResponseHeaders(event, artifactHeaders(isPublic))
    setResponseStatus(event, status)
    setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
    return body
  }
  if (method !== 'GET' && method !== 'HEAD') return plain(404, 'Not found')

  let d: ReturnType<typeof decideArtifactRequest>
  let isPublicArtifact = false
  try {
    const parsed = parseArtifactUrl(url.pathname)
    const found = parsed ? await findServable(parsed.slug) : null
    isPublicArtifact = !!found?.isPublic
    // Throws when BETTER_AUTH_SECRET is unset: answered as a bare 500 below, never served.
    const tokenStatus = !parsed?.token || !found ? 'absent' as const : verifyViewToken(parsed.token, found.artifactId)
    const needsSession = !!found && !found.isPublic && tokenStatus !== 'ok'
    const session = needsSession ? await useAuth().api.getSession({ headers: event.headers as Headers }).catch(() => null) : null
    const dest = getHeader(event, 'sec-fetch-dest')
    d = decideArtifactRequest({
      pathname: url.pathname, search: url.search, found,
      hasSession: !!session?.user, tokenStatus,
      isNavigation: dest === 'document' || dest === 'iframe' || !dest,
      mintToken: () => signViewToken(found!.artifactId)
    })
  } catch (e) {
    console.error('[artifact] request failed', e)
    return plain(500, 'Internal Server Error')
  }

  if (d.kind === 'not_found') return plain(404, 'Not found')
  setResponseHeaders(event, artifactHeaders(d.kind === 'serve' ? d.isPublic : isPublicArtifact))
  if (d.kind === 'forbidden') { setResponseStatus(event, 403); return 'Forbidden' }
  if (d.kind === 'redirect') return sendRedirect(event, d.location, d.status)
  setResponseHeader(event, 'content-type', d.file.contentType)
  setResponseHeader(event, 'content-length', d.file.size)
  setResponseHeader(event, 'etag', `"${d.file.sha256}"`)
  if (getHeader(event, 'if-none-match') === `"${d.file.sha256}"`) { setResponseStatus(event, 304); return '' }
  if (method === 'HEAD') return ''
  const { stream } = await storage().get(d.file.key)
  return sendStream(event, stream)
})
