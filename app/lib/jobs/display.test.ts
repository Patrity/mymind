import { describe, expect, it } from 'vitest'
import { formatAgo, formatDuration, formatInZone, formatRelative, outcomeColor, runNowToast, runOutcome, runThreadLink, type JobRunRow } from './display'

const run = (p: Partial<JobRunRow>): JobRunRow => ({
  id: 'r1', status: 'done', suppressed: false, createdAt: '2026-09-28T12:00:00Z',
  durationMs: 1200, conversationId: 'c-main', assistantMessageId: 'm1', ...p
})

describe('outcomeColor', () => {
  it('maps spoke/silent/failed/skipped to success/neutral/error/warning', () => {
    expect(outcomeColor('spoke')).toBe('success')
    expect(outcomeColor('silent')).toBe('neutral')
    expect(outcomeColor('failed')).toBe('error')
    expect(outcomeColor('skipped')).toBe('warning')
    expect(outcomeColor(null)).toBe('neutral')
  })
})

describe('runOutcome / runThreadLink', () => {
  it('done splits on suppressed; failure statuses read as failed; queued/running pass through', () => {
    expect(runOutcome(run({}))).toBe('spoke')
    expect(runOutcome(run({ suppressed: true }))).toBe('silent')
    expect(runOutcome(run({ status: 'aborted' }))).toBe('failed')
    expect(runOutcome(run({ status: 'interrupted' }))).toBe('failed')
    expect(runOutcome(run({ status: 'running' }))).toBe('running')
  })

  it('links to the thread only when the run spoke', () => {
    expect(runThreadLink(run({}))).toBe('/agent?c=c-main')
    expect(runThreadLink(run({ suppressed: true }))).toBeNull()
    expect(runThreadLink(run({ status: 'failed' }))).toBeNull()
    expect(runThreadLink(run({ conversationId: null }))).toBeNull()
  })
})

describe('time formatting', () => {
  it('formats in the job timezone, not the browser one', () => {
    const iso = '2026-09-28T11:30:00Z'
    expect(formatInZone(iso, 'America/New_York')).toBe('Mon, Sep 28, 7:30 AM EDT')
    expect(formatInZone(iso, 'Asia/Tokyo')).toBe('Mon, Sep 28, 8:30 PM GMT+9')
  })

  it('falls back instead of throwing on a bad timezone', () => {
    expect(() => formatInZone('2026-09-28T11:30:00Z', 'Not/AZone')).not.toThrow()
  })

  it('formats relative times both ways', () => {
    const now = new Date('2026-09-28T12:00:00Z')
    expect(formatRelative('2026-09-28T12:05:00Z', now)).toBe('in 5 minutes')
    expect(formatRelative('2026-09-28T09:00:00Z', now)).toBe('3 hours ago')
    expect(formatRelative('2026-09-30T12:00:00Z', now)).toBe('in 2 days')
    // 59.6 minutes rounds up into the next unit rather than reading "in 60 minutes".
    expect(formatRelative('2026-09-28T12:59:36Z', now)).toBe('in 1 hour')
  })

  it('formatAgo never puts a past event in the future', () => {
    const now = new Date('2026-09-28T12:00:00Z')
    expect(formatAgo('2026-09-28T12:00:20Z', now)).toBe('just now')
    expect(formatAgo('2026-09-28T11:59:30Z', now)).toBe('just now')
    expect(formatAgo('2026-09-28T11:55:00Z', now)).toBe('5 minutes ago')
  })

  it('formats durations', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(850)).toBe('850 ms')
    expect(formatDuration(12_400)).toBe('12 s')
    expect(formatDuration(125_000)).toBe('2 m 5 s')
  })
})

describe('runNowToast', () => {
  it('reports a start as success and a skip plainly as a warning', () => {
    expect(runNowToast({ runId: 'r' }).color).toBe('success')
    const t = runNowToast({ skipped: 'overlap' })
    expect(t).toMatchObject({ color: 'warning', title: 'skipped: overlap' })
  })
})
