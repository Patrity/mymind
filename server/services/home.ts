import { sql } from 'drizzle-orm'
import { useDb } from '../db'
import { homeRangeStart } from '../lib/home/range'
import { buildTimeline } from '../lib/home/timeline'
import type { RawEvent } from '../lib/home/timeline'
import { getUsageSince } from './usage'
import type {
  HomeRangeKey, HomeResponse, HomeMetrics, HomeAttention,
  HomeTaskRow, HomeProjectRow, HomeUsage
} from '../../shared/types/home'

/** Rows pulled per source before grouping. Generous — grouping collapses the noise. */
const PER_SOURCE_LIMIT = 200

// Written out per table rather than via a helper that `sql.raw`s identifiers —
// the table/column names would be the only interpolated parts, and this file
// should contain zero raw interpolation so a reviewer never has to reason about it.
async function metrics(db: ReturnType<typeof useDb>, start: Date): Promise<HomeMetrics> {
  const iso = start.toISOString()
  const one = (r: { rows: unknown[] }) => {
    const row = (r.rows as Record<string, unknown>[])[0] ?? {}
    return { total: Number(row.total ?? 0), delta: Number(row.delta ?? 0) }
  }
  const [ses, mem, doc, img] = await Promise.all([
    db.execute(sql`select count(*) as total, count(*) filter (where started_at >= ${iso}) as delta
                   from sessions`),
    db.execute(sql`select count(*) as total, count(*) filter (where created_at >= ${iso}) as delta
                   from memories where archived_at is null`),
    db.execute(sql`select count(*) as total, count(*) filter (where created_at >= ${iso}) as delta
                   from documents where deleted_at is null`),
    db.execute(sql`select count(*) as total, count(*) filter (where created_at >= ${iso}) as delta
                   from images`)
  ])
  return { sessions: one(ses), memories: one(mem), documents: one(doc), images: one(img) }
}

/** NOT range-scoped — absolute backlog. See the spec. */
async function attention(db: ReturnType<typeof useDb>): Promise<HomeAttention> {
  const r = await db.execute(sql`
    select
      (select count(*) from review_queue where status = 'pending')                        as conflicts,
      (select count(*) from memories where reviewed_at is null and archived_at is null)   as unreviewed,
      (select count(*) from activity_log where severity = 'error' and acked_at is null)   as errors,
      (select count(*) from documents where path like '/input/%' and deleted_at is null)  as unfiled`)
  const row = (r.rows as Record<string, unknown>[])[0] ?? {}
  return {
    conflicts: Number(row.conflicts ?? 0),
    unreviewedMemories: Number(row.unreviewed ?? 0),
    unackedErrors: Number(row.errors ?? 0),
    unfiledCaptures: Number(row.unfiled ?? 0)
  }
}

async function timelineEvents(db: ReturnType<typeof useDb>, start: Date): Promise<RawEvent[]> {
  const iso = start.toISOString()
  const [ses, mem, doc, img, clip, task, conf, err] = await Promise.all([
    db.execute(sql`select id, title, project, message_count, tool_count, started_at
                   from sessions where started_at >= ${iso}
                   order by started_at desc limit ${PER_SOURCE_LIMIT}`),
    db.execute(sql`select id, content, project, created_at from memories
                   where created_at >= ${iso} and archived_at is null
                   order by created_at desc limit ${PER_SOURCE_LIMIT}`),
    db.execute(sql`select id, path, title, project, created_at from documents
                   where created_at >= ${iso} and deleted_at is null
                   order by created_at desc limit ${PER_SOURCE_LIMIT}`),
    db.execute(sql`select id, original_name, summary, created_at from images
                   where created_at >= ${iso}
                   order by created_at desc limit ${PER_SOURCE_LIMIT}`),
    db.execute(sql`select id, body_text, kind, created_at from clip_messages
                   where created_at >= ${iso}
                   order by created_at desc limit ${PER_SOURCE_LIMIT}`),
    db.execute(sql`select id, title, status, project, coalesce(completed_at, created_at) as at
                   from tasks where coalesce(completed_at, created_at) >= ${iso} and deleted_at is null
                   order by at desc limit ${PER_SOURCE_LIMIT}`),
    db.execute(sql`select id, created_at from review_queue
                   where created_at >= ${iso} and status = 'pending'
                   order by created_at desc limit ${PER_SOURCE_LIMIT}`),
    db.execute(sql`select id, name, status, created_at from activity_log
                   where created_at >= ${iso} and severity = 'error'
                   order by created_at desc limit ${PER_SOURCE_LIMIT}`)
  ])

  const rows = (r: { rows: unknown[] }) => r.rows as Record<string, unknown>[]
  const str = (v: unknown) => (v == null ? '' : String(v))
  const trim = (v: unknown, n = 90) => {
    const s = str(v).replace(/\s+/g, ' ').trim()
    return s.length > n ? `${s.slice(0, n - 1)}…` : s
  }
  const proj = (v: unknown) => (v == null ? {} : { projectSlug: String(v) })

  return [
    ...rows(ses).map((r): RawEvent => ({
      id: `session:${str(r.id)}`, type: 'session', at: new Date(str(r.started_at)),
      title: str(r.title) || '(untitled session)',
      subtitle: `${Number(r.message_count ?? 0)} messages · ${Number(r.tool_count ?? 0)} tools`,
      href: `/sessions/${str(r.id)}`, ...proj(r.project)
    })),
    ...rows(mem).map((r): RawEvent => ({
      id: `memory:${str(r.id)}`, type: 'memory', at: new Date(str(r.created_at)),
      title: trim(r.content), href: '/memories', ...proj(r.project)
    })),
    ...rows(doc).map((r): RawEvent => ({
      id: `document:${str(r.id)}`, type: 'document', at: new Date(str(r.created_at)),
      title: str(r.title) || str(r.path).split('/').pop() || 'Untitled',
      subtitle: str(r.path), href: `/documents?doc=${str(r.id)}`, ...proj(r.project)
    })),
    ...rows(img).map((r): RawEvent => ({
      id: `image:${str(r.id)}`, type: 'image', at: new Date(str(r.created_at)),
      title: str(r.original_name) || trim(r.summary) || 'Image', href: '/gallery'
    })),
    ...rows(clip).map((r): RawEvent => ({
      id: `clipboard:${str(r.id)}`, type: 'clipboard', at: new Date(str(r.created_at)),
      title: str(r.kind) === 'file' ? 'File shared' : trim(r.body_text) || 'Clipboard item',
      href: '/clipboard'
    })),
    ...rows(task).map((r): RawEvent => ({
      id: `task:${str(r.id)}`, type: 'task', at: new Date(str(r.at)),
      title: str(r.status) === 'completed' ? `Completed: ${str(r.title)}` : str(r.title),
      href: '/tasks', ...proj(r.project)
    })),
    ...rows(conf).map((r): RawEvent => ({
      id: `conflict:${str(r.id)}`, type: 'conflict', at: new Date(str(r.created_at)),
      title: 'Memory conflict flagged', href: '/review'
    })),
    ...rows(err).map((r): RawEvent => ({
      id: `error:${str(r.id)}`, type: 'error', at: new Date(str(r.created_at)),
      title: str(r.name), subtitle: str(r.status), href: `/activity/${str(r.id)}`
    }))
  ]
}

async function activeTasks(db: ReturnType<typeof useDb>): Promise<HomeTaskRow[]> {
  const now = new Date().toISOString()
  const r = await db.execute(sql`
    select id, title, status, due_date, project,
           (due_date is not null and due_date < ${now} and status <> 'completed') as overdue
    from tasks
    where deleted_at is null and status in ('in_progress', 'todo', 'blocked')
    order by overdue desc, due_date asc nulls last, "order" asc
    limit 5`)
  return (r.rows as Record<string, unknown>[]).map(t => ({
    id: String(t.id),
    title: String(t.title),
    status: String(t.status),
    dueDate: t.due_date ? new Date(String(t.due_date)).toISOString() : null,
    overdue: t.overdue === true,
    projectSlug: t.project == null ? null : String(t.project),
    href: '/tasks'
  }))
}

async function recentProjects(db: ReturnType<typeof useDb>, start: Date): Promise<HomeProjectRow[]> {
  const iso = start.toISOString()
  const r = await db.execute(sql`
    with touched as (
      select project as slug, started_at as at from sessions where started_at >= ${iso} and project is not null
      union all
      select project, created_at from memories  where created_at >= ${iso} and project is not null and archived_at is null
      union all
      select project, created_at from documents where created_at >= ${iso} and project is not null and deleted_at is null
      union all
      select project, created_at from tasks     where created_at >= ${iso} and project is not null and deleted_at is null
    )
    select p.slug, p.name, p.color,
           max(t.at)                                        as last_at,
           count(*) filter (where t.at is not null)          as touches,
           (select count(*) from sessions s where s.project = p.slug and s.started_at >= ${iso}) as sessions,
           (select count(*) from memories m where m.project = p.slug and m.created_at >= ${iso} and m.archived_at is null) as memories
    from touched t join projects p on p.slug = t.slug
    group by p.slug, p.name, p.color
    order by last_at desc
    limit 5`)
  return (r.rows as Record<string, unknown>[]).map(p => ({
    slug: String(p.slug),
    name: String(p.name),
    color: p.color == null ? null : String(p.color),
    sessions: Number(p.sessions ?? 0),
    memories: Number(p.memories ?? 0),
    lastActivityAt: new Date(String(p.last_at)).toISOString(),
    href: `/projects/${String(p.slug)}`
  }))
}

export async function getHome(range: HomeRangeKey): Promise<HomeResponse> {
  const db = useDb()
  const start = homeRangeStart(range)

  const [m, a, events, tasks, projects, usageRaw] = await Promise.all([
    metrics(db, start),
    attention(db),
    timelineEvents(db, start),
    activeTasks(db),
    recentProjects(db, start),
    getUsageSince(start)
  ])

  const usage: HomeUsage = {
    tokens: usageRaw.totals.tokens,
    cacheReadPct: usageRaw.totals.cacheReadPct,
    valueUsd: usageRaw.totals.valueUsd,
    unpricedModels: usageRaw.unpriced.models
  }

  return {
    range,
    generatedAt: new Date().toISOString(),
    metrics: m,
    usage,
    timeline: buildTimeline(events),
    attention: a,
    tasks,
    projects
  }
}
