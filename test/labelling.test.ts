import { describe, it, expect } from 'vitest'
import {
  deriveVerdict,
  blindRow,
  parseLabels,
  formatLabelLine,
  remaining,
  applyQueue,
  type SampleRow,
  type Label
} from '../scripts/lib/labelling'

const row = (over: Partial<SampleRow> = {}): SampleRow => ({
  id: 'aaaaaaaa-0000-0000-0000-000000000001',
  stratum: 'main',
  scope: 'agent',
  content: 'Nitro OOM in the prod build was @tailwindcss/vite retaining both Rollup graphs.',
  project: 'mymind',
  source_date: '2026-08-01T00:00:00.000Z',
  created_at: '2026-08-02T00:00:00.000Z',
  confidence: 0.9,
  tags: ['gotcha', 'kind:gotcha', 'review:stale'],
  reviewed_at: '2026-08-02T00:00:00.000Z',
  enriched_at: '2026-08-02T00:00:00.000Z',
  session_id: 'bbbbbbbb-0000-0000-0000-000000000002',
  ...over
})

const label = (over: Partial<Label> = {}): Label => ({
  id: row().id,
  value: 2,
  durable: true,
  selfContained: true,
  verdict: 'keep',
  labelledAt: '2026-09-22T12:00:00.000Z',
  ...over
})

describe('deriveVerdict', () => {
  it('calls value 0 noise regardless of durability', () => {
    expect(deriveVerdict(0, true)).toBe('noise')
    expect(deriveVerdict(0, false)).toBe('noise')
  })

  it('calls a non-durable memory stale even when it is valuable', () => {
    // The staleness lens that matters: confident, useful-sounding, no longer true.
    expect(deriveVerdict(3, false)).toBe('stale')
    expect(deriveVerdict(2, false)).toBe('stale')
    expect(deriveVerdict(1, false)).toBe('stale')
  })

  it('keeps durable memories with any value above noise', () => {
    expect(deriveVerdict(1, true)).toBe('keep')
    expect(deriveVerdict(2, true)).toBe('keep')
    expect(deriveVerdict(3, true)).toBe('keep')
  })
})

describe('blindRow', () => {
  it('exposes only the fields a labeller may see', () => {
    expect(Object.keys(blindRow(row())).sort()).toEqual(
      ['content', 'id', 'project', 'scope', 'sourceDate'].sort()
    )
  })

  it('never leaks the signals under test', () => {
    // If any of these reach the screen, the labels are anchored on the thing
    // they are supposed to be validating and the ground truth is worthless.
    const shown = JSON.stringify(blindRow(row()))
    expect(shown).not.toContain('review:stale')
    expect(shown).not.toContain('kind:gotcha')
    expect(shown).not.toContain('0.9')
    expect(shown).not.toContain('reviewed')
  })

  it('falls back to created_at when source_date is null', () => {
    expect(blindRow(row({ source_date: null })).sourceDate).toBe('2026-08-02T00:00:00.000Z')
  })
})

describe('parseLabels', () => {
  it('reads back what formatLabelLine wrote', () => {
    const l = label()
    expect(parseLabels(formatLabelLine(l))).toEqual([l])
  })

  it('ignores blank lines and tolerates a trailing newline', () => {
    const text = `${formatLabelLine(label())}\n\n${formatLabelLine(label({ id: 'x', value: 0, verdict: 'noise' }))}\n`
    expect(parseLabels(text)).toHaveLength(2)
  })

  it('skips a truncated final line rather than throwing', () => {
    // A JSONL file whose process was killed mid-write must still resume.
    const text = `${formatLabelLine(label())}\n{"id":"half-writ`
    expect(parseLabels(text)).toHaveLength(1)
  })

  it('returns nothing for an empty file', () => {
    expect(parseLabels('')).toEqual([])
  })
})

describe('remaining', () => {
  const sample = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]

  it('returns every row when nothing is labelled', () => {
    expect(remaining(sample, []).map(r => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('drops already-labelled rows and preserves sample order', () => {
    expect(remaining(sample, [label({ id: 'b' })]).map(r => r.id)).toEqual(['a', 'c'])
  })

  it('returns empty once every row is labelled', () => {
    const all = sample.map(r => label({ id: r.id }))
    expect(remaining(sample, all)).toEqual([])
  })

  it('ignores labels for ids that are not in the sample', () => {
    expect(remaining(sample, [label({ id: 'zzz' })]).map(r => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not double-skip when a row was labelled twice', () => {
    const dupes = [label({ id: 'a' }), label({ id: 'a' })]
    expect(remaining(sample, dupes).map(r => r.id)).toEqual(['b', 'c'])
  })
})

describe('applyQueue', () => {
  const sample = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' }), row({ id: 'd' })]

  it('serves queued rows first, in queue order', () => {
    expect(applyQueue(sample, ['c', 'a']).map(r => r.id)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('keeps unqueued rows after, in sample order', () => {
    expect(applyQueue(sample, ['d']).map(r => r.id)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('returns sample order when the queue is empty', () => {
    expect(applyQueue(sample, []).map(r => r.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('ignores queued ids that are not in the sample', () => {
    expect(applyQueue(sample, ['zzz', 'b']).map(r => r.id)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('never drops or duplicates a row', () => {
    const out = applyQueue(sample, ['c', 'c', 'a'])
    expect(out).toHaveLength(sample.length)
    expect(new Set(out.map(r => r.id)).size).toBe(sample.length)
  })
})
