import { getByPublicSlug } from '../../services/documents'
export default defineEventHandler(async (event) => {
  const doc = await getByPublicSlug(getRouterParam(event, 'slug')!)
  if (!doc) throw createError({ statusCode: 404 })
  return { path: doc.path, title: doc.title, content: doc.content, language: doc.language, updatedAt: doc.updatedAt }
})
