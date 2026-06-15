import { and, desc, eq, ilike, lt, isNull, count, lte, ne, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { activityLog } from '../db/schema'
import type { ActivityRow } from '../db/schema/activity-log'
import type { ActivityDTO, ActivityListParams, ActivityCount, ActivitySeverity } from '../../shared/types/activity'
import type { ObservabilityConfig } from '../lib/observability/types'

// Pure: describe the filters a set of params implies (unit-testable without drizzle).
export interface FilterDesc { col: string, op: 'eq' | 'ilike', value: unknown }
export function buildActivityFilters(p: ActivityListParams): FilterDesc[] {
  const f: FilterDesc[] = []
  if (p.kind) f.push({ col: 'kind', op: 'eq', value: p.kind })
  if (p.status) f.push({ col: 'status', op: 'eq', value: p.status })
  if (p.severity) f.push({ col: 'severity', op: 'eq', value: p.severity })
  if (p.usage) f.push({ col: 'usage', op: 'eq', value: p.usage })
  if (p.traceId) f.push({ col: 'traceId', op: 'eq', value: p.traceId })
  if (p.q?.trim()) f.push({ col: 'name', op: 'ilike', value: `%${p.q.trim()}%` })
  return f
}

function toDTO(r: ActivityRow): ActivityDTO {
  return {
    id: r.id, traceId: r.traceId, parentId: r.parentId, kind: r.kind as ActivityDTO['kind'],
    name: r.name, status: r.status as ActivityDTO['status'], severity: r.severity as ActivityDTO['severity'],
    usage: r.usage, provider: r.provider, modelId: r.modelId, attempt: r.attempt, durationMs: r.durationMs,
    tokens: r.tokens as ActivityDTO['tokens'], request: r.request, response: r.response,
    error: r.error as ActivityDTO['error'], meta: (r.meta ?? {}) as Record<string, unknown>,
    ackedAt: r.ackedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null
  }
}

export async function listActivity(p: ActivityListParams): Promise<ActivityDTO[]> {
  const db = useDb()
  const conds: ReturnType<typeof eq>[] = []
  if (p.kind) conds.push(eq(activityLog.kind, p.kind))
  if (p.status) conds.push(eq(activityLog.status, p.status))
  if (p.severity) conds.push(eq(activityLog.severity, p.severity))
  if (p.usage) conds.push(eq(activityLog.usage, p.usage))
  if (p.traceId) conds.push(eq(activityLog.traceId, p.traceId))
  if (p.q?.trim()) conds.push(ilike(activityLog.name, `%${p.q.trim()}%`))
  if (p.before) conds.push(lt(activityLog.createdAt, new Date(p.before)))
  const rows = await db.select().from(activityLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(activityLog.createdAt))
    .limit(Math.min(p.limit ?? 100, 500))
  return rows.map(toDTO)
}

// Detail = the clicked row + every row sharing its trace_id (the full nested trace).
export async function getActivityTrace(id: string): Promise<{ root: ActivityDTO | null, trace: ActivityDTO[] }> {
  const db = useDb()
  const [row] = await db.select().from(activityLog).where(eq(activityLog.id, id)).limit(1)
  if (!row) return { root: null, trace: [] }
  const trace = await db.select().from(activityLog)
    .where(eq(activityLog.traceId, row.traceId)).orderBy(activityLog.createdAt)
  return { root: toDTO(row), trace: trace.map(toDTO) }
}

export async function countErrors(): Promise<ActivityCount> {
  const db = useDb()
  const [c] = await db.select({ n: count() }).from(activityLog)
    .where(and(eq(activityLog.status, 'error'), isNull(activityLog.ackedAt)))
  const [latest] = await db.select().from(activityLog)
    .where(and(eq(activityLog.status, 'error'), isNull(activityLog.ackedAt)))
    .orderBy(desc(activityLog.createdAt)).limit(1)
  return {
    unacked: c?.n ?? 0,
    latest: latest
      ? { id: latest.id, name: latest.name, severity: latest.severity as ActivitySeverity, at: latest.createdAt.toISOString() }
      : null
  }
}

export async function ackActivity(id: string): Promise<void> {
  await useDb().update(activityLog).set({ ackedAt: new Date() }).where(eq(activityLog.id, id))
}

export async function ackAllErrors(): Promise<void> {
  await useDb().update(activityLog).set({ ackedAt: new Date() })
    .where(and(eq(activityLog.status, 'error'), isNull(activityLog.ackedAt)))
}

export function pruneCutoffs(cfg: ObservabilityConfig, now: number) {
  const day = 86_400_000
  return {
    infoCutoff: new Date(now - cfg.retainInfoDays * day),
    errorCutoff: new Date(now - cfg.retainErrorDays * day)
  }
}

export async function pruneActivity(cfg: ObservabilityConfig, now = Date.now()): Promise<{ deleted: number }> {
  const db = useDb()
  const { infoCutoff, errorCutoff } = pruneCutoffs(cfg, now)
  // non-error rows older than the info window
  const a = await db.delete(activityLog)
    .where(and(ne(activityLog.status, 'error'), lte(activityLog.createdAt, infoCutoff)))
    .returning({ id: activityLog.id })
  // error rows older than the (longer) error window
  const b = await db.delete(activityLog)
    .where(and(eq(activityLog.status, 'error'), lte(activityLog.createdAt, errorCutoff)))
    .returning({ id: activityLog.id })
  // hard row cap (oldest first) — delete anything beyond maxRows
  await db.execute(sql`
    DELETE FROM activity_log WHERE id IN (
      SELECT id FROM activity_log ORDER BY created_at DESC OFFSET ${cfg.maxRows}
    )`)
  return { deleted: a.length + b.length }
}
