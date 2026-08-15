import { describe, it, expect } from 'vitest'
import { buildTimeline, utcDay, COLLAPSE_THRESHOLD, TIMELINE_CAP } from '../server/lib/home/timeline'
import type { RawEvent } from '../server/lib/home/timeline'
import type { TimelineType } from '../shared/types/home'

const ev = (
  type: TimelineType, iso: string, title: string, extra: Partial<RawEvent> = {}
): RawEvent => ({ id: `${type}-${iso}-${title}`, type, at: new Date(iso), title, href: `/x/${title}`, ...extra })

describe('utcDay', () => {
  it('buckets by UTC, not local time', () => {
    expect(utcDay(new Date('2026-08-15T23:59:59.000Z'))).toBe('2026-08-15')
    expect(utcDay(new Date('2026-08-16T00:00:00.000Z'))).toBe('2026-08-16')
  })
})

describe('buildTimeline grouping', () => {
  it('leaves a collapsible type alone at exactly the threshold', () => {
    const evs = Array.from({ length: COLLAPSE_THRESHOLD }, (_, i) =>
      ev('memory', `2026-08-15T0${i}:00:00.000Z`, `mem${i}`))
    const { days } = buildTimeline(evs)
    expect(days[0]!.entries).toHaveLength(COLLAPSE_THRESHOLD)
    expect(days[0]!.entries.every(e => e.count === undefined)).toBe(true)
  })

  it('collapses one over the threshold into a single summary row', () => {
    const evs = Array.from({ length: COLLAPSE_THRESHOLD + 1 }, (_, i) =>
      ev('memory', `2026-08-15T0${i}:00:00.000Z`, `mem${i}`))
    const { days } = buildTimeline(evs)
    expect(days[0]!.entries).toHaveLength(1)
    const row = days[0]!.entries[0]!
    expect(row.count).toBe(4)
    expect(row.title).toBe('4 memories learned')
    expect(row.href).toBe('/memories')
    // newest two named, remainder counted
    expect(row.subtitle).toBe('mem3, mem2, +2')
  })

  it('NEVER collapses sessions or errors, however many there are', () => {
    const evs = [
      ...Array.from({ length: 9 }, (_, i) => ev('session', `2026-08-15T0${i}:00:00.000Z`, `s${i}`)),
      ...Array.from({ length: 9 }, (_, i) => ev('error', `2026-08-15T1${i}:00:00.000Z`, `e${i}`))
    ]
    const { days } = buildTimeline(evs)
    expect(days[0]!.entries).toHaveLength(18)
    expect(days[0]!.entries.every(e => e.count === undefined)).toBe(true)
  })

  it('groups per day, not across days', () => {
    const evs = [
      ...Array.from({ length: 4 }, (_, i) => ev('memory', `2026-08-15T0${i}:00:00.000Z`, `a${i}`)),
      ...Array.from({ length: 4 }, (_, i) => ev('memory', `2026-08-14T0${i}:00:00.000Z`, `b${i}`))
    ]
    const { days } = buildTimeline(evs)
    expect(days.map(d => d.day)).toEqual(['2026-08-15', '2026-08-14'])
    expect(days[0]!.entries[0]!.title).toBe('4 memories learned')
    expect(days[1]!.entries[0]!.title).toBe('4 memories learned')
  })

  it('groups per type, not across types', () => {
    const evs = [
      ...Array.from({ length: 4 }, (_, i) => ev('memory', `2026-08-15T0${i}:00:00.000Z`, `m${i}`)),
      ...Array.from({ length: 4 }, (_, i) => ev('image', `2026-08-15T1${i}:00:00.000Z`, `i${i}`))
    ]
    const { days } = buildTimeline(evs)
    expect(days[0]!.entries.map(e => e.title)).toEqual(['4 images added', '4 memories learned'])
  })
})

describe('buildTimeline ordering', () => {
  it('orders days and entries newest first', () => {
    const evs = [
      ev('session', '2026-08-13T10:00:00.000Z', 'old'),
      ev('session', '2026-08-15T10:00:00.000Z', 'new'),
      ev('session', '2026-08-15T08:00:00.000Z', 'mid')
    ]
    const { days } = buildTimeline(evs)
    expect(days.map(d => d.day)).toEqual(['2026-08-15', '2026-08-13'])
    expect(days[0]!.entries.map(e => e.title)).toEqual(['new', 'mid'])
  })

  it('sorts a collapsed group by its newest member', () => {
    const evs = [
      ev('session', '2026-08-15T05:00:00.000Z', 'session-row'),
      ...Array.from({ length: 4 }, (_, i) => ev('memory', `2026-08-15T0${i}:00:00.000Z`, `m${i}`))
    ]
    // newest memory is 03:00, which is older than the 05:00 session
    const { days } = buildTimeline(evs)
    expect(days[0]!.entries.map(e => e.title)).toEqual(['session-row', '4 memories learned'])
  })
})

describe('buildTimeline cap', () => {
  it('caps rows and reports the uncapped total so truncation can be disclosed', () => {
    const evs = Array.from({ length: 10 }, (_, i) =>
      ev('session', `2026-08-15T${String(i).padStart(2, '0')}:00:00.000Z`, `s${i}`))
    const t = buildTimeline(evs, { cap: 4 })
    expect(t.shown).toBe(4)
    expect(t.total).toBe(10)
    expect(t.days.flatMap(d => d.entries)).toHaveLength(4)
  })

  it('keeps the NEWEST rows when capping', () => {
    const evs = Array.from({ length: 5 }, (_, i) =>
      ev('session', `2026-08-15T0${i}:00:00.000Z`, `s${i}`))
    const t = buildTimeline(evs, { cap: 2 })
    expect(t.days[0]!.entries.map(e => e.title)).toEqual(['s4', 's3'])
  })

  it('counts POST-grouping rows in total, not raw events', () => {
    const evs = Array.from({ length: 20 }, (_, i) =>
      ev('memory', `2026-08-15T${String(i).padStart(2, '0')}:00:00.000Z`, `m${i}`))
    const t = buildTimeline(evs)
    expect(t.total).toBe(1)   // 20 memories collapse to one row
    expect(t.shown).toBe(1)
  })

  it('defaults the cap to TIMELINE_CAP', () => {
    const evs = Array.from({ length: TIMELINE_CAP + 25 }, (_, i) =>
      ev('session', new Date(Date.UTC(2026, 7, 15, 0, i)).toISOString(), `s${i}`))
    const t = buildTimeline(evs)
    expect(t.shown).toBe(TIMELINE_CAP)
    expect(t.total).toBe(TIMELINE_CAP + 25)
  })

  it('empty input -> empty timeline, not a crash', () => {
    expect(buildTimeline([])).toEqual({ days: [], shown: 0, total: 0 })
  })
})

describe('buildTimeline entry shape', () => {
  it('carries href, subtitle and projectSlug through for ungrouped rows', () => {
    const t = buildTimeline([
      ev('session', '2026-08-15T10:00:00.000Z', 'Usage tab', {
        href: '/sessions/abc', subtitle: '216 messages', projectSlug: 'mymind'
      })
    ])
    expect(t.days[0]!.entries[0]).toMatchObject({
      type: 'session', title: 'Usage tab', href: '/sessions/abc',
      subtitle: '216 messages', projectSlug: 'mymind', at: '2026-08-15T10:00:00.000Z'
    })
  })

  it('omits subtitle/projectSlug keys when absent rather than setting undefined', () => {
    const t = buildTimeline([ev('session', '2026-08-15T10:00:00.000Z', 'bare')])
    expect('subtitle' in t.days[0]!.entries[0]!).toBe(false)
    expect('projectSlug' in t.days[0]!.entries[0]!).toBe(false)
  })
})
