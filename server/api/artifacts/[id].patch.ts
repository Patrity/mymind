import { z } from 'zod'
import { editArtifact, resolveArtifactRef } from '@mymind/core/lib/artifacts/service'
import { ArtifactError } from '@mymind/core/lib/artifacts/limits'

const Body = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().nullable().optional(),
  slug: z.string().optional(),
  isPublic: z.boolean().optional(),
  projectId: z.string().uuid().nullable().optional(),
  rollbackTo: z.number().int().positive().optional()
})

// PATCH /api/artifacts/:id — the service emits the live-bus change; do not publish here.
export default defineEventHandler(async (event) => {
  const ref = getRouterParam(event, 'id')!
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    const message = parsed.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
    throw createError({ statusCode: 400, statusMessage: 'invalid body', message })
  }
  const id = await resolveArtifactRef(ref)
  if (!id) throw createError({ statusCode: 404, statusMessage: 'artifact not found' })
  try {
    const dto = await editArtifact(id, parsed.data)
    if (!dto) throw createError({ statusCode: 404, statusMessage: 'artifact not found' })
    return dto
  } catch (e) {
    if (e instanceof ArtifactError) throw createError({ statusCode: 400, statusMessage: 'artifact error', message: e.message })
    throw e
  }
})
