// Cycle 86 (spec §5): the serving route's decisions, kept pure so every branch is unit-tested.
import { SLUG_RE, type Manifest, type ManifestEntry } from './limits'
import { lookupPath } from './manifest'

export const ARTIFACT_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads'

export function artifactHeaders(isPublic: boolean): Record<string, string> {
  return {
    'content-security-policy': ARTIFACT_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // Sandboxed pages have an opaque origin, so their fetch()/XHR are cross-origin. No credentials are
    // ever allowed: private access is by path token, not cookie.
    'access-control-allow-origin': '*',
    'cache-control': isPublic ? 'public, max-age=60' : 'private, no-store'
  }
}

export function parseArtifactUrl(pathname: string) {
  const m = /^\/artifact\/([^/]+)(\/.*)?$/.exec(pathname)
  if (!m) return null
  const slug = m[1]!
  if (!SLUG_RE.test(slug)) return null
  const rest = m[2] ?? ''
  let segs = rest.split('/').slice(1) // '' for '/'
  let token: string | null = null
  if (segs[0]?.startsWith('~')) { token = segs[0].slice(1); segs = segs.slice(1) }
  let path: string
  try { path = segs.map(s => decodeURIComponent(s)).filter(s => s !== '').join('/') } catch { return null }
  if (rest.endsWith('/') && path) path += '/'
  return { slug, token, path, trailingSlash: rest !== '' }
}

export type ServeDecision =
  | { kind: 'redirect'; status: 301 | 302; location: string }
  | { kind: 'serve'; path: string; file: ManifestEntry; isPublic: boolean }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }

export interface DecideInput {
  pathname: string
  search: string
  found: { artifactId: string; slug: string; isPublic: boolean; manifest: Manifest; entry: string; spaFallback: boolean } | null
  hasSession: boolean
  tokenStatus: 'ok' | 'expired' | 'invalid' | 'absent'
  isNavigation: boolean
  mintToken: () => string
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/')

export function decideArtifactRequest(i: DecideInput): ServeDecision {
  const u = parseArtifactUrl(i.pathname)
  if (!u || !i.found) return { kind: 'not_found' }
  const a = i.found
  // Spec §5: a private artifact must look exactly like a missing one to anything that isn't a navigation.
  // A slash-less URL has no token segment, so a subresource here can never be authorised.
  if (!u.trailingSlash) {
    if (!a.isPublic && !i.isNavigation) return { kind: 'not_found' }
    return { kind: 'redirect', status: 301, location: `/artifact/${u.slug}/${i.search}` }
  }
  const serve = (): ServeDecision => {
    const hit = lookupPath(a.manifest, a.entry, a.spaFallback, u.path)
    return hit ? { kind: 'serve', path: hit.path, file: hit.file, isPublic: a.isPublic } : { kind: 'not_found' }
  }
  if (a.isPublic) return serve()
  if (u.token !== null && i.tokenStatus === 'ok') return serve()
  // No usable token: a navigation goes (back) through the session check; a subresource can't.
  if (!i.isNavigation) return u.token !== null ? { kind: 'forbidden' } : { kind: 'not_found' }
  if (i.hasSession) return { kind: 'redirect', status: 302, location: `/artifact/${u.slug}/~${i.mintToken()}/${encodePath(u.path)}${i.search}` }
  return { kind: 'redirect', status: 302, location: `/login?redirect=${encodeURIComponent(`/artifact/${u.slug}/`)}` }
}
