import { and, isNull, ilike, or, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { images, tasks, projects } from '../db/schema'
import { searchDocs } from './documents'
import { searchMemories } from './memory'
import { serveUrl } from './images'
import type { SearchResults } from '../../shared/types/search'

const emptyResults = (): SearchResults => ({
  documents: [],
  memories: [],
  images: [],
  tasks: [],
  projects: []
})

export async function searchAll(q: string, perGroup = 5): Promise<SearchResults> {
  if (!q.trim()) return emptyResults()

  const [documents, memories, imgs, taskItems, projectItems] = await Promise.all([
    // Lane: documents (hybrid vector+trigram via searchDocs)
    (async () => {
      try {
        const rows = await searchDocs(q)
        return rows.slice(0, perGroup).map(r => ({
          type: 'document' as const,
          id: r.id,
          title: r.title || r.path,
          path: r.path,
          to: '/documents?doc=' + r.id
        }))
      } catch {
        return []
      }
    })(),

    // Lane: memories (hybrid vector+trigram via searchMemories)
    (async () => {
      try {
        const rows = await searchMemories(q, { limit: perGroup })
        return rows.map(r => ({
          type: 'memory' as const,
          id: r.id,
          snippet: r.content.slice(0, 120),
          scope: r.scope,
          relevance: r.relevance,
          to: '/memories'
        }))
      } catch {
        return []
      }
    })(),

    // Lane: images — ocr_text ILIKE or tag array overlap
    (async () => {
      try {
        const db = useDb()
        const pattern = `%${q}%`
        const rows = await db.select().from(images)
          .where(
            and(
              isNull(images.deletedAt),
              or(
                ilike(images.ocrText, pattern),
                sql`${images.tags} && ARRAY[${q}]::text[]`,
                sql`${images.recommendedTags} && ARRAY[${q}]::text[]`
              )
            )
          )
          .limit(perGroup)
        return rows.map(r => ({
          type: 'image' as const,
          id: r.id,
          url: serveUrl(r),
          tags: r.tags,
          to: '/gallery'
        }))
      } catch {
        return []
      }
    })(),

    // Lane: tasks — ILIKE filter on title/description then JS slice
    (async () => {
      try {
        const db = useDb()
        const pattern = `%${q}%`
        const rows = await db.select().from(tasks)
          .where(
            and(
              isNull(tasks.deletedAt),
              or(
                ilike(tasks.title, pattern),
                ilike(tasks.description, pattern)
              )
            )
          )
          .limit(perGroup)
        return rows.map(r => ({
          type: 'task' as const,
          id: r.id,
          title: r.title,
          status: r.status,
          to: '/tasks'
        }))
      } catch {
        return []
      }
    })(),

    // Lane: projects — ILIKE on name or slug
    (async () => {
      try {
        const db = useDb()
        const pattern = `%${q}%`
        const rows = await db.select().from(projects)
          .where(
            or(
              ilike(projects.name, pattern),
              ilike(projects.slug, pattern)
            )
          )
          .limit(perGroup)
        return rows.map(r => ({
          type: 'project' as const,
          slug: r.slug,
          name: r.name,
          to: '/projects'
        }))
      } catch {
        return []
      }
    })()
  ])

  return { documents, memories, images: imgs, tasks: taskItems, projects: projectItems }
}
