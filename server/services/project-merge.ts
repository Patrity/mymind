/**
 * uniquifyPath: If target not in taken, return unchanged; else insert -2/-3/… before extension.
 * Split on last `/` for dir+name; split name on last `.` for base+ext.
 * Try `${dir}/${base}-${n}${ext ? '.'+ext : ''}` for n=2,3,… until not in taken.
 */
export function uniquifyPath(target: string, taken: Set<string>): string {
  if (!taken.has(target)) {
    return target
  }

  // Split on last `/` to get dir and name
  const lastSlashIdx = target.lastIndexOf('/')
  const dir = lastSlashIdx === -1 ? '' : target.slice(0, lastSlashIdx)
  const name = lastSlashIdx === -1 ? target : target.slice(lastSlashIdx + 1)

  // Split name on last `.` to get base and ext
  const lastDotIdx = name.lastIndexOf('.')
  const base = lastDotIdx === -1 ? name : name.slice(0, lastDotIdx)
  const ext = lastDotIdx === -1 ? '' : name.slice(lastDotIdx)

  // Try base-2, base-3, ... until we find one not in taken
  for (let n = 2; n < 10000; n++) {
    const candidate = dir
      ? `${dir}/${base}-${n}${ext}`
      : `${base}-${n}${ext}`

    if (!taken.has(candidate)) {
      return candidate
    }
  }

  // Fallback (should never reach if logic is correct)
  return target
}

/**
 * mergeStringArrays: Concat + dedupe, preserving a's order first then new items from b.
 * Empty inputs → [].
 */
export function mergeStringArrays(a: string[], b: string[]): string[] {
  const seen = new Set<string>(a)
  const result: string[] = [...a]

  for (const item of b) {
    if (!seen.has(item)) {
      seen.add(item)
      result.push(item)
    }
  }

  return result
}
