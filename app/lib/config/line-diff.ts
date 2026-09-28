/**
 * A small line-level diff for the Skills/Jobs revisions panel (cycle 74). The repo has no diff
 * dependency and revisions are short markdown (a skill body is capped at 20k chars), so a plain
 * LCS table is plenty. Pure — no DOM, no I/O.
 */
export type DiffLineKind = 'same' | 'add' | 'del'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

/** Above this many LCS cells the table would cost too much memory; fall back to "all removed,
 *  then all added", which is still a correct (if unhelpful) diff. */
export const LINE_DIFF_MAX_CELLS = 4_000_000

function splitLines(s: string): string[] {
  return s === '' ? [] : s.replace(/\r\n/g, '\n').split('\n')
}

/** Line diff turning `before` into `after`: `del` lines exist only in before, `add` only in after. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  const n = a.length
  const m = b.length

  if ((n + 1) * (m + 1) > LINE_DIFF_MAX_CELLS) {
    return [...a.map(text => ({ kind: 'del' as const, text })), ...b.map(text => ({ kind: 'add' as const, text }))]
  }

  // lcs[i][j] = LCS length of a[i..] and b[j..], stored flat.
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j]
        ? lcs[(i + 1) * w + j + 1]! + 1
        : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!)
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
      out.push({ kind: 'del', text: a[i]! })
      i++
    } else {
      out.push({ kind: 'add', text: b[j]! })
      j++
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++]! })
  while (j < m) out.push({ kind: 'add', text: b[j++]! })
  return out
}
