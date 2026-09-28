import { z } from 'zod'
import { upsertSession } from '../../../services/sessions'
import { eq } from 'drizzle-orm'
import { publishChange } from '../../../utils/live-bus'
import { useDb } from '../../../db'
import { projects, type Session } from '../../../db/schema'
import { fireEvent } from '../../../lib/agent/jobs/events'

const Body = z.object({
  source: z.string().default('claude_code'),
  external_id: z.string(),
  project: z.string().nullish(),
  cwd: z.string().nullish(),
  git_branch: z.string().nullish(),
  git_commit: z.string().nullish(),
  git_remote: z.string().nullish(),
  git_root: z.string().nullish(),
  machine_id: z.string().nullish(),
  hostname: z.string().nullish(),
  app_version: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).optional()
})

export default defineEventHandler(async (event) => {
  const eventName = getRouterParam(event, 'event') ?? 'unknown'
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    // A malformed body is a client error (400), not a server crash (500). The
    // transcript route already does this; keep the two hook routes consistent.
    throw createError({ statusCode: 400, statusMessage: 'Bad Request', data: parsed.error.issues })
  }
  const body = parsed.data

  const metadata: Record<string, unknown> = { ...(body.metadata ?? {}), lastEvent: eventName }
  const isEnd = eventName === 'SessionEnd'

  const session = await upsertSession({
    source: body.source,
    externalId: body.external_id,
    project: body.project ?? undefined,
    cwd: body.cwd ?? undefined,
    gitBranch: body.git_branch ?? undefined,
    gitCommit: body.git_commit ?? undefined,
    gitRemote: body.git_remote ?? undefined,
    gitRoot: body.git_root ?? undefined,
    machineId: body.machine_id ?? undefined,
    hostname: body.hostname ?? undefined,
    appVersion: body.app_version ?? undefined,
    endedAt: isEnd ? new Date() : undefined,
    metadata
  })

  publishChange({ resource: 'session', action: 'updated', id: session.id })
  // Cycle 74: `cc.session_end` event jobs. Fire-and-forget — the hook answers Claude Code
  // immediately; dedupe (key = session id) makes a repeated SessionEnd delivery harmless.
  if (isEnd) void fireSessionEnd(session).catch(err => console.error('[jobs] cc.session_end failed:', err))
  return { ok: true, sessionId: session.id }
})

async function fireSessionEnd(session: Session): Promise<void> {
  // The one extra read: the canonical project slug (the row only carries its id).
  let project = session.project ?? null
  if (session.projectId) {
    const [p] = await useDb().select({ slug: projects.slug }).from(projects).where(eq(projects.id, session.projectId)).limit(1)
    project = p?.slug ?? project
  }
  const endedAt = session.endedAt ?? new Date()
  const durationMinutes = Math.max(0, Math.round((endedAt.getTime() - session.startedAt.getTime()) / 60_000))
  await fireEvent('cc.session_end', session.id, {
    sessionId: session.id, title: session.title, project, durationMinutes, summary: session.summary
  })
}
