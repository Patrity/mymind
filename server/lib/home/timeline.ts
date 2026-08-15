import type { HomeTimeline, TimelineDay, TimelineEntry, TimelineType } from '../../../shared/types/home'

export interface RawEvent {
  id: string
  type: TimelineType
  at: Date
  title: string
  subtitle?: string
  projectSlug?: string
  href: string
}

/**
 * Types whose every occurrence is individually actionable, so they are never
 * summarised. `embeddings:all-failed` sat unseen for nine days — it must never
 * be folded into "3 errors". Sessions are the headline units of "work I did".
 */
export const NEVER_COLLAPSE: ReadonlySet<TimelineType> = new Set<TimelineType>(['session', 'error'])

/** A day holding MORE than this many of one collapsible type becomes one summary row. */
export const COLLAPSE_THRESHOLD = 3

/** Max rows after grouping. Overflow is DISCLOSED via `total`, never silently dropped. */
export const TIMELINE_CAP = 60

const GROUP_LABEL: Record<TimelineType, string> = {
  session: 'sessions',
  error: 'errors',
  memory: 'memories learned',
  document: 'documents saved',
  image: 'images added',
  clipboard: 'clipboard items',
  task: 'task updates',
  conflict: 'memory conflicts flagged'
}

const GROUP_HREF: Record<TimelineType, string> = {
  session: '/sessions',
  error: '/activity',
  memory: '/memories',
  document: '/documents',
  image: '/gallery',
  clipboard: '/clipboard',
  task: '/tasks',
  conflict: '/review'
}

/** 'YYYY-MM-DD' in UTC — pinned so bucketing can't drift with the server timezone. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function toEntry(e: RawEvent): TimelineEntry {
  return {
    id: e.id,
    type: e.type,
    at: e.at.toISOString(),
    title: e.title,
    ...(e.subtitle ? { subtitle: e.subtitle } : {}),
    ...(e.projectSlug ? { projectSlug: e.projectSlug } : {}),
    href: e.href
  }
}

export function buildTimeline(events: RawEvent[], opts: { cap?: number } = {}): HomeTimeline {
  const cap = opts.cap ?? TIMELINE_CAP

  // 1. bucket by (UTC day, type)
  const byDay = new Map<string, Map<TimelineType, RawEvent[]>>()
  for (const e of events) {
    const day = utcDay(e.at)
    let types = byDay.get(day)
    if (!types) { types = new Map(); byDay.set(day, types) }
    const list = types.get(e.type)
    if (list) list.push(e)
    else types.set(e.type, [e])
  }

  // 2. collapse each (day, type) bucket where allowed
  const rows: (TimelineEntry & { _at: number })[] = []
  for (const [day, types] of byDay) {
    for (const [type, list] of types) {
      list.sort((a, b) => b.at.getTime() - a.at.getTime())

      if (NEVER_COLLAPSE.has(type) || list.length <= COLLAPSE_THRESHOLD) {
        for (const e of list) rows.push({ ...toEntry(e), _at: e.at.getTime() })
        continue
      }

      const newest = list[0]!
      const named = list.slice(0, 2).map(e => e.title).join(', ')
      const rest = list.length - 2
      rows.push({
        id: `group:${day}:${type}`,
        type,
        at: newest.at.toISOString(),
        title: `${list.length} ${GROUP_LABEL[type]}`,
        subtitle: rest > 0 ? `${named}, +${rest}` : named,
        href: GROUP_HREF[type],
        count: list.length,
        _at: newest.at.getTime()
      })
    }
  }

  // 3. newest first, then cap — `total` is the uncapped post-grouping row count
  rows.sort((a, b) => b._at - a._at)
  const total = rows.length
  const kept = rows.slice(0, cap)

  // 4. regroup into day sections, preserving order
  const days: TimelineDay[] = []
  for (const row of kept) {
    const { _at, ...entry } = row
    void _at
    const day = entry.at.slice(0, 10)
    const last = days[days.length - 1]
    if (last && last.day === day) last.entries.push(entry)
    else days.push({ day, entries: [entry] })
  }

  return { days, shown: kept.length, total }
}
