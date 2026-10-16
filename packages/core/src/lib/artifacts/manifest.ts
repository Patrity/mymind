// Cycle 87 (spec §3–§5): pure manifest operations.
import { ARTIFACT_MAX_FILES, ARTIFACT_MAX_TOTAL_BYTES, ArtifactError, normalizeArtifactPath, type Manifest, type ManifestEntry } from './limits'

export const isDataPath = (p: string) => p.startsWith('data/')

// Own-key reads only: a plain object would otherwise answer 'constructor', '__proto__', 'toString' etc. from its prototype.
const own = (m: Manifest, p: string): ManifestEntry | undefined => (Object.hasOwn(m, p) ? m[p] : undefined)

export function mergeManifest(prev: Manifest | null, next: Manifest, merge: boolean): Manifest {
  return merge && prev ? { ...prev, ...next } : { ...next }
}

export function onlyDataChanged(prev: Manifest, next: Manifest): boolean {
  const paths = new Set([...Object.keys(prev), ...Object.keys(next)])
  let changed = false
  for (const p of paths) {
    if (own(prev, p)?.sha256 === own(next, p)?.sha256) continue
    if (!isDataPath(p)) return false
    changed = true
  }
  return changed
}

export function manifestStats(m: Manifest) {
  const files = Object.values(m)
  return { files: files.length, totalBytes: files.reduce((n, f) => n + f.size, 0) }
}

export function validateManifest(m: Manifest, entry: string): void {
  const { files, totalBytes } = manifestStats(m)
  if (files > ARTIFACT_MAX_FILES) throw new ArtifactError(`bundle has ${files} files; the limit is ${ARTIFACT_MAX_FILES}`, 'too_many')
  if (totalBytes > ARTIFACT_MAX_TOTAL_BYTES) throw new ArtifactError(`bundle is ${totalBytes} bytes; the limit is 25 MB`, 'too_large')
  if (!own(m, entry)) throw new ArtifactError(`entry ${entry} not found — did you publish the build output directory?`, 'no_entry')
}

export function lookupPath(m: Manifest, entry: string, spaFallback: boolean, reqPath: string): { path: string; file: ManifestEntry } | null {
  if (reqPath === '') { const e = own(m, entry); return e ? { path: entry, file: e } : null }
  let p: string
  try { p = normalizeArtifactPath(reqPath.endsWith('/') ? reqPath + 'index.html' : reqPath) } catch { return null }
  const hit = own(m, p)
  if (hit) return { path: p, file: hit }
  const last = p.split('/').pop()!
  const fallback = own(m, entry)
  if (spaFallback && !last.includes('.') && fallback) return { path: entry, file: fallback }
  return null
}
