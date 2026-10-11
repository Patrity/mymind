// Cycle 81 Task 1 (fix round 1) — the run-event writer's retry/ordering/error surfacing against an
// injected store (no DB). The real-DB paths (incl. a genuine (run_id, seq) clash) are in
// bus.db.test.ts.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRunEventWriter, RunEventWriteError, type HubFrame, type NewRunEventRow, type RunEventStore } from './events'

afterEach(() => { vi.restoreAllMocks() })

function fakeStore(failures: (rows: NewRunEventRow[], call: number) => unknown) {
  const rows: NewRunEventRow[] = []
  let calls = 0
  let maxSeqCalls = 0
  const store: RunEventStore = {
    async maxSeq() { maxSeqCalls++; return rows.reduce((m, r) => Math.max(m, r.seq), 0) },
    async append(batch) {
      const err = failures(batch, ++calls)
      if (err) throw err
      for (const r of batch) {
        if (rows.some(x => x.runId === r.runId && x.seq === r.seq)) throw Object.assign(new Error('duplicate key'), { code: '23505' })
      }
      rows.push(...batch)
    }
  }
  return { store, rows, calls: () => calls, maxSeqCalls: () => maxSeqCalls }
}

const state = (s: 'thinking' | 'tool' | 'idle'): HubFrame => ({ type: 'state', state: s })
const fast = { attempts: 4, baseMs: 5, maxMs: 20 }

describe('run event writer — retries', () => {
  it('retries a transiently failing batch and keeps emit order (later batches wait behind it)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = fakeStore((_b, call) => call <= 2 ? new Error('connection reset') : null)
    const w = createRunEventWriter('r1', 'c1', { store: f.store, retry: fast })
    w.emit(state('thinking'))
    await new Promise(r => setTimeout(r, 1)) // first batch now in flight (and failing)
    w.emit({ type: 'approval', requestId: 'q1', tool: 'exec', command: 'ls', proposedPattern: 'ls', allowlistable: false })
    w.emit({ type: 'persisted', conversationId: 'c1' })
    await w.close()
    expect(f.rows.map(r => [r.seq, r.type])).toEqual([[1, 'state'], [2, 'approval'], [3, 'persisted']])
    expect(f.calls()).toBe(4) // 2 failures + 2 batches
  })

  it('a batch failing every attempt is surfaced (onError + flush rejects) — and the writer keeps going', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let down = true
    const f = fakeStore(() => down ? new Error('db down') : null)
    const errors: RunEventWriteError[] = []
    const w = createRunEventWriter('r2', 'c2', { store: f.store, retry: fast, onError: e => errors.push(e) })
    w.emit({ type: 'approval', requestId: 'q', tool: 'exec', command: 'x', proposedPattern: 'x', allowlistable: false })
    const err = await w.flush().catch(e => e)
    expect(err).toBeInstanceOf(RunEventWriteError)
    expect((err as RunEventWriteError).frameTypes).toEqual(['approval'])
    expect(errors).toHaveLength(1)
    expect(f.calls()).toBe(fast.attempts)
    down = false
    w.emit(state('idle'))
    await expect(w.close()).resolves.toBeUndefined() // reported once, not again
    expect(f.rows.map(r => r.type)).toEqual(['state'])
  })

  it('a (run_id, seq) clash with another writer re-reads max(seq) and continues after it', async () => {
    const f = fakeStore(() => null)
    const a = createRunEventWriter('r3', 'c3', { store: f.store, retry: fast })
    const b = createRunEventWriter('r3', 'c3', { store: f.store, retry: fast })
    a.emit(state('thinking')); await a.flush() // a: seq 1
    b.emit(state('tool')); await b.flush()     // b reads max=1 → seq 2
    a.emit(state('idle')); await a.close()     // a still thinks next is 2 → clash → re-read → 3
    expect(f.rows.map(r => r.seq)).toEqual([1, 2, 3])
    expect(f.maxSeqCalls()).toBe(3)
  })
})
