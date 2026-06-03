import { eq } from 'drizzle-orm'
import { useDb } from '../db'
import { projects } from '../db/schema'
import type { ProjectDTO } from '../../shared/types/tasks'
import { slugify } from '../../shared/utils/slugify'

// ---------------------------------------------------------------------------
// DTO mapper
// ---------------------------------------------------------------------------

function toDTO(r: typeof projects.$inferSelect): ProjectDTO {
  return {
    slug: r.slug,
    name: r.name,
    description: r.description,
    active: r.active,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString()
  }
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

export async function listProjects(filter: { activeOnly?: boolean } = {}): Promise<ProjectDTO[]> {
  const db = useDb()
  const rows = filter.activeOnly
    ? await db.select().from(projects).where(eq(projects.active, true))
    : await db.select().from(projects)
  return rows.map(toDTO)
}

export async function getProject(slug: string): Promise<ProjectDTO | null> {
  const [r] = await useDb()
    .select()
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1)
  return r ? toDTO(r) : null
}

export interface CreateProjectInput {
  name: string
  description?: string
  slug?: string
}

export async function createProject(input: CreateProjectInput): Promise<ProjectDTO> {
  const slug = input.slug ?? slugify(input.name)

  // Check for existing project with the same slug
  const existing = await getProject(slug)
  if (existing) {
    throw new Error(`Project with slug "${slug}" already exists`)
  }

  const rows = await useDb()
    .insert(projects)
    .values({
      slug,
      name: input.name,
      description: input.description ?? ''
    })
    .returning()
  return toDTO(rows[0]!)
}

export interface UpdateProjectInput {
  name?: string
  description?: string
  active?: boolean
}

export async function updateProject(slug: string, patch: UpdateProjectInput): Promise<ProjectDTO | null> {
  const update: Record<string, unknown> = { updatedAt: new Date() }
  if (patch.name !== undefined) update.name = patch.name
  if (patch.description !== undefined) update.description = patch.description
  if (patch.active !== undefined) update.active = patch.active

  const [r] = await useDb()
    .update(projects)
    .set(update as Partial<typeof projects.$inferInsert>)
    .where(eq(projects.slug, slug))
    .returning()
  return r ? toDTO(r) : null
}

export async function archiveProject(slug: string): Promise<ProjectDTO | null> {
  return updateProject(slug, { active: false })
}

export async function deleteProject(slug: string): Promise<boolean> {
  const [r] = await useDb()
    .delete(projects)
    .where(eq(projects.slug, slug))
    .returning({ slug: projects.slug })
  return !!r
}
