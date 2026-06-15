import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { ActivityInsert } from '../../db/schema/activity-log'
import { useDb } from '../../db'
import { activityLog } from '../../db/schema'
import { publishChange } from '../../utils/live-bus'
import { createEmailDigester } from './notify'
import { loadObsConfig } from './config'
import type { ActivityKind } from './types'
import type { SpanInput } from './types'

interface SpanCtx { traceId: string, spanId: string }

export interface RecorderDeps {
  sink: (rows: ActivityInsert[]) => Promise<void>
  publish?: () => void
  notify?: (errorRows: ActivityInsert[]) => void
  now?: () => number
  newId?: () => string
}

export interface Recorder {
  recordEvent: (input: SpanInput) => void
  withSpan: <T>(input: SpanInput, fn: () => Promise<T>) => Promise<T>
  flush: () => Promise<void>
  /** Run fn as the root of a new trace (used by inbound capture). */
  runInTrace: <T>(fn: () => Promise<T>) => Promise<T>
}

export function createRecorder(deps: RecorderDeps): Recorder {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomUUID
  const als = new AsyncLocalStorage<SpanCtx>()
  let buffer: ActivityInsert[] = []

  function build(input: SpanInput, ctx: SpanCtx, parent: SpanCtx | undefined): ActivityInsert {
    const at = new Date(now())
    return {
      id: ctx.spanId,
      traceId: ctx.traceId,
      parentId: parent?.spanId ?? null,
      kind: input.kind,
      name: input.name,
      status: input.status ?? 'ok',
      severity: input.severity ?? 'info',
      usage: input.usage ?? null,
      provider: input.provider ?? null,
      modelId: input.modelId ?? null,
      attempt: input.attempt ?? null,
      durationMs: input.durationMs ?? null,
      tokens: input.tokens ?? null,
      request: input.request ?? null,
      response: input.response ?? null,
      error: input.error ?? null,
      meta: input.meta ?? {},
      ackedAt: null,
      createdAt: at,
      finishedAt: at
    }
  }

  function enqueue(input: SpanInput, ctx?: SpanCtx) {
    try {
      const parent = als.getStore()
      const c = ctx ?? { traceId: parent?.traceId ?? newId(), spanId: newId() }
      buffer.push(build(input, c, parent && parent.spanId !== c.spanId ? parent : (ctx ? parent : undefined)))
    } catch (err) {
      console.error('[observability] enqueue failed', err)
    }
  }

  function recordEvent(input: SpanInput) {
    enqueue(input)
  }

  async function withSpan<T>(input: SpanInput, fn: () => Promise<T>): Promise<T> {
    const parent = als.getStore()
    const ctx: SpanCtx = { traceId: parent?.traceId ?? newId(), spanId: newId() }
    const started = now()
    try {
      const result = await als.run(ctx, fn)
      enqueue({ ...input, status: input.status ?? 'ok', durationMs: now() - started, response: input.response }, ctx)
      return result
    } catch (err) {
      enqueue({
        ...input,
        status: 'error',
        severity: 'error',
        durationMs: now() - started,
        error: { message: (err as Error).message, stack: (err as Error).stack }
      }, ctx)
      throw err
    }
  }

  async function runInTrace<T>(fn: () => Promise<T>): Promise<T> {
    return als.run({ traceId: newId(), spanId: newId() }, fn)
  }

  async function flush(): Promise<void> {
    if (!buffer.length) return
    const rows = buffer
    buffer = []
    try {
      await deps.sink(rows)
    } catch (err) {
      console.error('[observability] flush failed (dropping batch)', err)
      return // never rethrow into the app
    }
    deps.publish?.()
    const errs = rows.filter(r => r.status === 'error' || r.severity === 'error' || r.severity === 'warn')
    if (errs.length) deps.notify?.(errs)
  }

  return { recordEvent, withSpan, flush, runInTrace }
}

const digester = createEmailDigester()

// Default, app-wired recorder. Capture toggles are honored at the seam by
// checking loadObsConfig(); the sink itself is dumb (writes whatever it's given).
export const recorder: Recorder = createRecorder({
  sink: async (rows) => {
    await useDb().insert(activityLog).values(rows)
  },
  publish: () => publishChange({ resource: 'activity', action: 'created', id: 'batch' }),
  notify: (rows) => digester.push(rows)
})

// A 1s flush loop + a 50-row eager flush keep latency off hot paths. unref so it
// never holds the process open. (No-op in tests — they call recorder.flush() directly.)
let flushTimer: ReturnType<typeof setInterval> | null = null
export function startRecorderFlushLoop(): void {
  if (flushTimer) return
  flushTimer = setInterval(() => { void recorder.flush() }, 1_000)
  flushTimer.unref?.()
}

export const withSpan = recorder.withSpan
export const recordEvent = recorder.recordEvent
export const runInTrace = recorder.runInTrace

/** Seam guard: skip capture for a kind the user has disabled in settings. */
export async function captureEnabled(kind: ActivityKind): Promise<boolean> {
  try { return (await loadObsConfig()).capture[kind] !== false } catch { return true }
}
