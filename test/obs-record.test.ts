import { describe, it, expect, vi } from 'vitest'
import { createRecorder } from '../server/lib/observability/record'
import type { ActivityInsert } from '../server/db/schema/activity-log'

function harness() {
  const rows: ActivityInsert[] = []
  let n = 0
  const rec = createRecorder({
    sink: async (batch) => { rows.push(...batch) },
    publish: vi.fn(),
    notify: vi.fn(),
    now: () => 1000,
    newId: () => `id-${++n}`
  })
  return { rec, rows }
}

describe('withSpan', () => {
  it('records one ok row at completion and returns fn result', async () => {
    const { rec, rows } = harness()
    const out = await rec.withSpan({ kind: 'job', name: 'enrich-input' }, async () => 42)
    await rec.flush()
    expect(out).toBe(42)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('job')
    expect(rows[0]!.status).toBe('ok')
    expect(rows[0]!.parentId).toBeNull()
  })

  it('nests children under the active span via trace_id/parent_id', async () => {
    const { rec, rows } = harness()
    await rec.withSpan({ kind: 'job', name: 'parent' }, async () => {
      await rec.withSpan({ kind: 'model', name: 'chat:reasoning' }, async () => 'ok')
    })
    await rec.flush()
    const job = rows.find(r => r.kind === 'job')!
    const model = rows.find(r => r.kind === 'model')!
    expect(model.traceId).toBe(job.traceId)
    expect(model.parentId).toBe(job.id)
  })

  it('records an error row and re-throws (never swallows)', async () => {
    const { rec, rows } = harness()
    await expect(rec.withSpan({ kind: 'model', name: 'x' }, async () => { throw new Error('boom') }))
      .rejects.toThrow('boom')
    await rec.flush()
    expect(rows[0]!.status).toBe('error')
    expect((rows[0]!.error as { message: string }).message).toBe('boom')
    expect(rows[0]!.severity).toBe('error')
  })
})

describe('recordEvent', () => {
  it('is non-interfering: a throwing sink never propagates', async () => {
    const rows: ActivityInsert[] = []
    const rec = createRecorder({ sink: async () => { throw new Error('db down') }, now: () => 1, newId: () => 'x' })
    rec.recordEvent({ kind: 'attempt', name: 'a', status: 'error', severity: 'error' })
    await expect(rec.flush()).resolves.toBeUndefined() // swallowed, not thrown
    expect(rows).toHaveLength(0)
  })

  it('calls publish once per flush and notify with error rows only', async () => {
    const publish = vi.fn(); const notify = vi.fn()
    const rec = createRecorder({ sink: async () => {}, publish, notify, now: () => 1, newId: () => 'x' })
    rec.recordEvent({ kind: 'job', name: 'ok', severity: 'info' })
    rec.recordEvent({ kind: 'attempt', name: 'bad', status: 'error', severity: 'error' })
    await rec.flush()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toHaveLength(1) // only the error row
  })
})
