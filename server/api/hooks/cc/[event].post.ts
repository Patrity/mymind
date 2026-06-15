import { z } from 'zod'
import { upsertSession } from '../../../services/sessions'
import { publishChange } from '../../../utils/live-bus'

const Body = z.object({
  source: z.string().default('claude_code'),
  external_id: z.string(),
  project: z.string().nullish(),
  cwd: z.string().nullish(),
  git_branch: z.string().nullish(),
  git_commit: z.string().nullish(),
  git_remote: z.string().nullish(),
  machine_id: z.string().nullish(),
  hostname: z.string().nullish(),
  app_version: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).optional()
})

export default defineEventHandler(async (event) => {
  const eventName = getRouterParam(event, 'event') ?? 'unknown'
  const body = Body.parse(await readBody(event))

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
    machineId: body.machine_id ?? undefined,
    hostname: body.hostname ?? undefined,
    appVersion: body.app_version ?? undefined,
    endedAt: isEnd ? new Date() : undefined,
    metadata
  })

  publishChange({ resource: 'session', action: 'updated', id: session.id })
  return { ok: true, sessionId: session.id }
})
