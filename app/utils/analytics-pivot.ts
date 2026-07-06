// Pure: Series[] -> Unovis row objects (one row per timestamp, one key per series).
import type { Series } from '~~/shared/types/analytics'

export function pivotSeries(series: Series[]): { rows: Record<string, number | null>[], keys: string[] } {
  const keys = series.map(s => s.name)
  const byT = new Map<number, Record<string, number | null>>()
  for (const s of series) {
    for (const p of s.points) {
      let row = byT.get(p.t)
      if (!row) { row = { t: p.t }; byT.set(p.t, row) }
      row[s.name] = p.v
    }
  }
  const rows = [...byT.values()].sort((a, b) => (a.t! - b.t!))
  for (const row of rows) for (const k of keys) if (!(k in row)) row[k] = null
  return { rows, keys }
}
