import { decideReview } from '@mymind/core/services/review-decisions'

// A thin wrapper over decideReview — see approve.post.ts.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const r = await decideReview(id, 'reject', { route: true })
  if (!r.ok) {
    if (r.reason === 'unknown_kind') throw createError({ statusCode: 400, statusMessage: `Unknown review kind: ${r.kind}` })
    throw createError({ statusCode: 404 })
  }
  return { ok: true }
})
