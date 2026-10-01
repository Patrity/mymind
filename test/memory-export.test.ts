import { describe, it, expect } from 'vitest'
import { mergeLabels, toExportRow, csvField, toCsv, toJsonl, EXPORT_COLUMNS, type MemoryScoreRow } from '../scripts/lib/memory-export'
import type { Label } from '../scripts/lib/labelling'

const base: MemoryScoreRow = {
  id: 'm1',
  content: 'Tony uses pnpm',
  scope: 'user',
  project: 'mymind',
  created_at: new Date('2026-09-01T00:00:00Z'),
  confidence: 0.9,
  extract_prompt_version: null,
  audit_keep: 0.7,
  audit_verdict: 'keep',
  audit_reason: 'stable tooling preference',
  audit_model: 'qwen',
  audit_prompt_version: 'audit-v1',
  audited_at: new Date('2026-10-01T00:00:00Z'),
  audit_failures: 0,
  jev_score: 0.3,
  jev_answers: { transient: 0.2 },
  jev_model: 'jev-1.13.0',
  jev_scored_at: new Date('2026-10-01T00:00:00Z'),
  jev_failures: 0,
  archived_at: null,
  reviewed_at: '2026-09-02T00:00:00Z'
}

const label = (id: string, verdict: Label['verdict'], value: Label['value'] = 2): Label =>
  ({ id, value, durable: verdict === 'keep', selfContained: true, verdict, labelledAt: '2026-09-23T00:00:00Z' })

describe('mergeLabels', () => {
  it('a later file / later line wins for a re-labelled id', () => {
    const m = mergeLabels([[label('a', 'keep'), label('a', 'stale')], [label('b', 'noise'), label('a', 'noise', 0)]])
    expect(m.get('a')?.verdict).toBe('noise')
    expect(m.get('a')?.value).toBe(0)
    expect(m.get('b')?.verdict).toBe('noise')
    expect(m.size).toBe(2)
  })
})

describe('toExportRow', () => {
  it('maps scores, state and the joined label', () => {
    const r = toExportRow(base, mergeLabels([[label('m1', 'stale', 1)]]))
    expect(r).toMatchObject({
      id: 'm1',
      created_at: '2026-09-01T00:00:00.000Z',
      extraction_confidence: 0.9,
      audit_keep: 0.7,
      audit_verdict: 'keep',
      jev_keep: 0.3,
      jev_answers: { transient: 0.2 },
      archived: false,
      reviewed: true,
      label_verdict: 'stale',
      label_value: 1,
      label_durable: false,
      label_self_contained: true
    })
  })

  it('disagreement is exact at the 0.4 boundary (float noise rounded away)', () => {
    expect(toExportRow(base, new Map()).disagreement).toBe(0.4)
  })

  it('disagreement is null when either score is missing, never 0', () => {
    expect(toExportRow({ ...base, jev_score: null }, new Map()).disagreement).toBeNull()
    expect(toExportRow({ ...base, audit_keep: null }, new Map()).disagreement).toBeNull()
  })

  it('an unlabelled memory has null label fields; archived state is carried', () => {
    const r = toExportRow({ ...base, archived_at: new Date(), reviewed_at: null }, new Map())
    expect(r.archived).toBe(true)
    expect(r.reviewed).toBe(false)
    expect(r.label_verdict).toBeNull()
    expect(r.label_value).toBeNull()
  })
})

describe('csv', () => {
  it('quotes commas, quotes and newlines; nulls are empty; objects become JSON', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a, b')).toBe('"a, b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('line1\nline2')).toBe('"line1\nline2"')
    expect(csvField(null)).toBe('')
    expect(csvField({ a: 1 })).toBe('"{""a"":1}"')
    expect(csvField(false)).toBe('false')
  })

  it('header lists every column; one line per row', () => {
    const csv = toCsv([toExportRow(base, new Map())])
    const [header] = csv.split('\n')
    expect(header).toBe(EXPORT_COLUMNS.join(','))
    expect(csv.trim().split('\n')).toHaveLength(2)
  })

  it('jsonl is one parseable object per line', () => {
    const out = toJsonl([toExportRow(base, new Map()), toExportRow({ ...base, id: 'm2' }, new Map())])
    expect(out.trim().split('\n').map(l => JSON.parse(l).id)).toEqual(['m1', 'm2'])
    expect(toJsonl([])).toBe('')
  })
})

// Final review M4: prod is native with no .env (CD wipes /opt/mymind), and a plain --env-file is
// fatal when the file is missing — so the export must only load .env when it exists.
describe('pnpm memory:export', () => {
  it('loads .env only if present', async () => {
    const { readFileSync } = await import('node:fs')
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['memory:export']).toContain('--env-file-if-exists=.env')
    expect(pkg.scripts['memory:export']).not.toMatch(/--env-file=/)
  })
})
