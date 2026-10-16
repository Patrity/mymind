// Cycle 87 (spec §5): /artifact/<slug>/… — outside /api, so it does its own auth. All decisions are
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
  if (method === 'OPTIONS') {
    setResponseHeaders(event, {
      ...artifactHeaders(false),
      'access-control-allow-methods': 'GET, HEAD',
      'access-control-allow-headers': '*',
      'access-control-max-age': 600
    })
    setResponseStatus(event, 204)
    return ''
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
    const dest = getHeader(event, 'sec-fetch-dest')
    const isNavigation = dest === 'document' || dest === 'iframe' || !dest
    // An unknown slug on a navigation needs the session too: logged out, it answers like a private one.
    const needsSession = found ? !found.isPublic && tokenStatus !== 'ok' : !!parsed && isNavigation
    const session = needsSession ? await useAuth().api.getSession({ headers: event.headers as Headers }).catch(() => null) : null
    d = decideArtifactRequest({
      pathname: url.pathname, search: url.search, found,
      hasSession: !!session?.user, tokenStatus,
      isNavigation,
      mintToken: () => signViewToken(found!.artifactId)
    })
  } catch (e) {
    console.error('[artifact] request failed', e)
    return plain(500, 'Internal Server Error')
  }

  if (d.kind === 'not_found') return plain(404, 'Not found')
  if (d.kind === 'forbidden') return plain(403, 'Forbidden', isPublicArtifact)
  if (d.kind === 'redirect') {
    setResponseHeaders(event, artifactHeaders(isPublicArtifact))
    return sendRedirect(event, d.location, d.status)
  }
  // Fetch the blob BEFORE setting any file headers: a missing blob must not leave the real file's
  // etag/content-length/public cache on an error response.
  let stream: Awaited<ReturnType<ReturnType<typeof storage>['get']>>['stream'] | null = null
  const skipBody = method === 'HEAD' || getHeader(event, 'if-none-match') === `"${d.file.sha256}"`
  if (!skipBody) {
    try { stream = (await storage().get(d.file.key)).stream } catch (e) {
      console.error('[artifact] blob fetch failed', e)
      return plain(500, 'Internal Server Error')
    }
  }
  setResponseHeaders(event, artifactHeaders(d.isPublic))
  setResponseHeader(event, 'content-type', d.file.contentType)
  setResponseHeader(event, 'content-length', d.file.size)
  setResponseHeader(event, 'etag', `"${d.file.sha256}"`)
  if (!stream) {
    if (method !== 'HEAD') setResponseStatus(event, 304)
    return ''
  }
  return sendStream(event, stream)
})
