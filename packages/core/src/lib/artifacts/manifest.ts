// Cycle 86 (spec §3–§5): pure manifest operations.
import { ARTIFACT_MAX_FILES, ARTIFACT_MAX_TOTAL_BYTES, ArtifactError, normalizeArtifactPath, type Manifest, type ManifestEntry } from './limits'

export const isDataPath = (p: string) => p.startsWith('data/')

export function mergeManifest(prev: Manifest | null, next: Manifest, merge: boolean): Manifest {
  return merge && prev ? { ...prev, ...next } : { ...next }
}

export function onlyDataChanged(prev: Manifest, next: Manifest): boolean {
  const paths = new Set([...Object.keys(prev), ...Object.keys(next)])
  let changed = false
  for (const p of paths) {
    if (prev[p]?.sha256 === next[p]?.sha256) continue
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
  if (!m[entry]) throw new ArtifactError(`entry ${entry} not found — did you publish the build output directory?`, 'no_entry')
}

export function lookupPath(m: Manifest, entry: string, spaFallback: boolean, reqPath: string): { path: string; file: ManifestEntry } | null {
  if (reqPath === '') return m[entry] ? { path: entry, file: m[entry]! } : null
  let p: string
  try { p = normalizeArtifactPath(reqPath.endsWith('/') ? reqPath + 'index.html' : reqPath) } catch { return null }
  if (m[p]) return { path: p, file: m[p]! }
  const last = p.split('/').pop()!
  if (spaFallback && !last.includes('.') && m[entry]) return { path: entry, file: m[entry]! }
  return null
}
