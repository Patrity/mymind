import { HOME_RANGE_KEYS } from '../../../shared/types/home'
import type { HomeRangeKey } from '../../../shared/types/home'

const DAYS: Record<HomeRangeKey, number> = { '1d': 1, '3d': 3, '7d': 7, '30d': 30 }

export function isHomeRange(v: string): v is HomeRangeKey {
  return (HOME_RANGE_KEYS as readonly string[]).includes(v)
}

/**
 * Lower bound for a range, truncated to UTC midnight. Unlike `rangeStart` in
 * server/services/usage.ts this never returns null — home has no `all` key.
 */
export function homeRangeStart(range: HomeRangeKey, now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  d.setUTCDate(d.getUTCDate() - DAYS[range])
  return d
}
