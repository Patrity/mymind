import { eq, or, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { projects, sessions, memories } from '../db/schema'
import type { ProjectDTO } from '../../shared/types/tasks'
import { slugify } from '../../shared/utils/slugify'
import { normalizeGitRemote, repoNameFromKey, nextUniqueSlug } from '../lib/projects/git-remote'

// ---------------------------------------------------------------------------
// DTO mapper
// ---------------------------------------------------------------------------

function toDTO(r: typeof projects.$inferSelect, counts?: { sessionCount: number, memoryCount: number }): ProjectDTO {
  return {
    id: r.id, slug: r.slug, name: r.name, description: r.description, active: r.active,
    color: r.color, gitRemoteKey: r.gitRemoteKey, repositoryUrl: r.repositoryUrl,
    productionUrl: r.productionUrl, stagingUrl: r.stagingUrl,
    aliases: r.aliases ?? [], localPaths: r.localPaths ?? [],
    lastActivityAt: r.lastActivityAt?.toISOString() ?? null,
    sessionCount: counts?.sessionCount ?? 0, memoryCount: counts?.memoryCount ?? 0,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString()
  }
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

export async function listProjects(filter: { activeOnly?: boolean } = {}): Promise<ProjectDTO[]> {
  const db = useDb()
  const rows = await db.select({
    project: projects,
    sessionCount: sql<number>`(select count(*)::int from ${sessions} s where s.project_id = ${projects.id})`,
    memoryCount: sql<number>`(select count(*)::int from ${memories} m where m.project_id = ${projects.id})`
  }).from(projects).where(filter.activeOnly ? eq(projects.active, true) : undefined)
    .orderBy(sql`coalesce(${projects.lastActivityAt}, ${projects.createdAt}) desc`)
  return rows.map(r => toDTO(r.project, { sessionCount: r.sessionCount, memoryCount: r.memoryCount }))
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
  name?: string; description?: string; active?: boolean
  color?: string | null; repositoryUrl?: string | null
  productionUrl?: string | null; stagingUrl?: string | null; aliases?: string[]
}

export async function updateProject(slug: string, patch: UpdateProjectInput): Promise<ProjectDTO | null> {
  const update: Record<string, unknown> = { updatedAt: new Date() }
  if (patch.name !== undefined) update.name = patch.name
  if (patch.description !== undefined) update.description = patch.description
  if (patch.active !== undefined) update.active = patch.active
  if (patch.color !== undefined) update.color = patch.color
  if (patch.repositoryUrl !== undefined) update.repositoryUrl = patch.repositoryUrl
  if (patch.productionUrl !== undefined) update.productionUrl = patch.productionUrl
  if (patch.stagingUrl !== undefined) update.stagingUrl = patch.stagingUrl
  if (patch.aliases !== undefined) update.aliases = patch.aliases

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

/**
 * Resolve a session's project. Matches on the normalized git remote (then aliases),
 * creating a project on first sight. Sessions with no remote MATCH an existing
 * project by cwd label (slug / aliases) but never create — falling back to the
 * seeded Uncategorized bucket. Race on git_remote_key falls back to re-select.
 */
export async function findOrCreateProject(input: { gitRemote?: string | null, cwd?: string | null }): Promise<typeof projects.$inferSelect> {
  const db = useDb()
  const key = normalizeGitRemote(input.gitRemote)
  const cwd = input.cwd ?? null

  // Touch a matched project: append cwd to local_paths + bump last_activity_at.
  const touch = async (proj: typeof projects.$inferSelect): Promise<typeof projects.$inferSelect> => {
    const localPaths = (proj.localPaths ?? [])
    const nextPaths = cwd && !localPaths.includes(cwd) ? [...localPaths, cwd] : localPaths
    const now = new Date()
    await db.update(projects).set({ localPaths: nextPaths, lastActivityAt: now, updatedAt: now }).where(eq(projects.id, proj.id))
    return { ...proj, localPaths: nextPaths, lastActivityAt: now }
  }

  if (!key) {
    // No git remote: try to MATCH (never create) an existing project by cwd label / slug / alias.
    const label = cwd ? cwd.split('/').filter(Boolean).at(-1) ?? null : null
    if (label) {
      const lslug = slugify(label)
      const [match] = await db.select().from(projects).where(or(
        eq(projects.slug, lslug),
        sql`${projects.aliases} @> ARRAY[${label}]::text[]`,
        sql`${projects.aliases} @> ARRAY[${lslug}]::text[]`
      )).limit(1)
      if (match) return touch(match)
    }
    const [u] = await db.select().from(projects).where(eq(projects.slug, 'uncategorized')).limit(1)
    return u! // seeded by migration 0019
  }

  let [proj] = await db.select().from(projects).where(eq(projects.gitRemoteKey, key)).limit(1)
  if (!proj) {
    ;[proj] = await db.select().from(projects).where(sql`${projects.aliases} @> ARRAY[${key}]::text[]`).limit(1)
  }
  if (proj) return touch(proj)

  const taken = new Set((await db.select({ slug: projects.slug }).from(projects)).map(r => r.slug))
  const slug = nextUniqueSlug(slugify(repoNameFromKey(key)) || 'project', taken)
  try {
    const [created] = await db.insert(projects).values({
      slug, name: repoNameFromKey(key), gitRemoteKey: key,
      repositoryUrl: input.gitRemote ?? null,
      localPaths: cwd ? [cwd] : [], lastActivityAt: new Date()
    }).returning()
    return created!
  } catch {
    // unique race on git_remote_key — another ingest created it first
    const [racer] = await db.select().from(projects).where(eq(projects.gitRemoteKey, key)).limit(1)
    if (racer) return racer
    throw new Error(`findOrCreateProject: failed to create or find project for key ${key}`)
  }
}
