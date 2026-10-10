// server/utils/agent-config-http.ts
// Shared HTTP glue for the jobs + skill-source routes (cycle 74, Task 9) — both target kinds go
// through the same markdown + CAS + revision pattern (config/revisions.ts), so they share the
// same status-code contract too:
//   - a malformed slug/name -> 400 BEFORE touching the DB (same reasoning as folder-http.ts's
//     requireFolderId: a malformed one can never match a real row anyway, so failing fast on
//     shape is strictly better than a wasted query).
//   - ConflictError (CAS mismatch, or a create-only save landing on an existing slug) -> 409,
//     carrying `current` so the editor can show what's actually there instead of clobbering it.
//   - JobNotFoundError -> 404. Skills has no equivalent class (saveSkillSource/revertSkill throw
//     a plain Error for "no skill named ..."), so skills routes pre-check existence themselves
//     and 404 before ever calling into the write path — see source.put.ts / revert.post.ts.
//   - JobValidationError, and any other plain Error (skills' own validation failures included,
//     since it has no dedicated class) -> 400. Matches the existing server/api/skills/[name].put.ts
//     default.
import type { H3Event } from 'h3'
import { JOB_SLUG_RE, JobValidationError, JobNotFoundError } from '@mymind/core/lib/agent/jobs/store'
import { ConflictError, SKILL_NAME_RE } from '@mymind/core/services/skills'

export function requireJobSlug(event: H3Event): string {
  const slug = getRouterParam(event, 'slug')
  if (!slug || !JOB_SLUG_RE.test(slug)) {
    throw createError({ statusCode: 400, statusMessage: `invalid slug: ${slug ?? ''}` })
  }
  return slug
}

export function requireSkillName(event: H3Event): string {
  const name = getRouterParam(event, 'name')
  if (!name || !SKILL_NAME_RE.test(name)) {
    throw createError({ statusCode: 400, statusMessage: `invalid name: ${name ?? ''}` })
  }
  return name
}

/** Maps a jobs/skills write-path failure onto the shared status contract described above. */
export function throwAgentConfigWriteError(err: unknown): never {
  if (err instanceof ConflictError) {
    throw createError({ statusCode: 409, statusMessage: err.message, data: { current: err.current } })
  }
  if (err instanceof JobNotFoundError) {
    throw createError({ statusCode: 404, statusMessage: err.message })
  }
  if (err instanceof JobValidationError) {
    throw createError({ statusCode: 400, statusMessage: err.message })
  }
  const e = err as { statusCode?: number, message?: string }
  if (e.statusCode) throw err // already a shaped H3 error — pass it through unmodified
  throw createError({ statusCode: 400, statusMessage: e.message ?? String(err) })
}
