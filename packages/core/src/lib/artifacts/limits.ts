// Cycle 86 (spec §3): artifact limits, the content-type allowlist and path/slug rules — pure.
export const ARTIFACT_MAX_TOTAL_BYTES = 25 * 1024 * 1024
export const ARTIFACT_MAX_FILES = 500
export const ARTIFACT_MAX_FILE_BYTES = 10 * 1024 * 1024

export type ManifestEntry = { key: string; sha256: string; size: number; contentType: string }
export type Manifest = Record<string, ManifestEntry>

export class ArtifactError extends Error {
  override name = 'ArtifactError'
  constructor(message: string, readonly code: 'bad_path' | 'bad_type' | 'too_large' | 'too_many' | 'no_entry' | 'bad_slug' | 'not_found' | 'bad_input' | 'refused') { super(message) }
}

const TEXT = '; charset=utf-8'
const TYPES: Record<string, string> = {
  html: 'text/html' + TEXT, htm: 'text/html' + TEXT, js: 'text/javascript' + TEXT, mjs: 'text/javascript' + TEXT,
  css: 'text/css' + TEXT, json: 'application/json' + TEXT, map: 'application/json' + TEXT, txt: 'text/plain' + TEXT,
  csv: 'text/csv' + TEXT, svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff',
  woff2: 'font/woff2', ttf: 'font/ttf', wasm: 'application/wasm', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm'
}
const TEXT_EXTS = new Set(['html', 'htm', 'js', 'mjs', 'css', 'json', 'map', 'txt', 'csv', 'svg'])

const ext = (p: string) => { const m = /\.([a-z0-9]+)$/i.exec(p); return m ? m[1]!.toLowerCase() : '' }
export function contentTypeFor(path: string): string | null { const e = ext(path); return Object.hasOwn(TYPES, e) ? TYPES[e]! : null }
export function isTextPath(path: string): boolean { return TEXT_EXTS.has(ext(path)) }

export function normalizeArtifactPath(p: string): string {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.includes('\\') || p.startsWith('/') || p.endsWith('/'))
    throw new ArtifactError(`bad path ${JSON.stringify(p)}: must be a relative file path`, 'bad_path')
  const parts = p.split('/').filter(s => s !== '' && s !== '.')
  if (!parts.length || parts.some(s => s === '..'))
    throw new ArtifactError(`bad path ${JSON.stringify(p)}: no .. or empty segments`, 'bad_path')
  return parts.join('/')
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
/** UUID-shaped slugs are reserved: id-or-slug lookups (resolveArtifactRef) would match an id first. */
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export function slugProblem(s: string): string | null {
  if (!SLUG_RE.test(s)) return 'slug must be 1–64 chars of a-z, 0-9 and -, not starting or ending with -'
  return UUID_SHAPED.test(s) ? 'slug must not be UUID-shaped' : null
}
export function slugFromTitle(title: string): string {
  // NFKD splits accents into combining marks (\p{M}); dropping them keeps 'Résumé' → 'resume'.
  const s = title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '')
  if (UUID_SHAPED.test(s)) return `artifact-${s}`
  return s || 'artifact'
}
