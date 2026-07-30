import type { PagedResult } from '../../../shared/types/summaries'

/** Default page size for agent read tools — small enough that 25 rows never overflow a tool result. */
export const DEFAULT_LIMIT = 25
export const MAX_LIMIT = 100

/** Normalise caller-supplied paging into safe integers. */
export function clampPaging(limit?: number, offset?: number): { limit: number, offset: number } {
  const l = Math.trunc(limit ?? DEFAULT_LIMIT)
  const o = Math.trunc(offset ?? 0)
  return {
    limit: Math.min(MAX_LIMIT, Math.max(1, l)),
    offset: Math.max(0, o)
  }
}

/**
 * Wrap a window of rows in the standard envelope.
 *
 * `hasMore` is computed from `total` rather than from `items.length === limit`, so a full
 * final page correctly reports `hasMore: false` instead of luring the agent into fetching
 * an empty page.
 */
export function buildPage<T>(items: T[], total: number, limit: number, offset: number): PagedResult<T> {
  return { items, total, hasMore: offset + items.length < total }
}
