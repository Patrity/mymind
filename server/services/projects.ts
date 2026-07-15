import { eq, or, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { projects, sessions, memories, tasks, documents } from '../db/schema'
import type { ProjectDTO } from '../../shared/types/tasks'
import { slugify } from '../../shared/utils/slugify'
import { normalizeGitRemote, repoNameFromKey, nextUniqueSlug } from '../lib/projects/git-remote'
import { longestPrefixMatch, basenameOf, isAutoCreatable, normalizePrefix } from '../lib/projects/path-routing'

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Bare row select: no count subqueries. Used for existence/uniqueness checks only.
 */
async function projectRowBySlug(slug: string) {
  const [r] = await useDb().select().from(projects).where(eq(projects.slug, slug)).limit(1)
  return r ?? null
}

// Count subqueries keyed on the denormalized project SLUG — the same key the
// `?project=` session/task/memory/document filters (and the project dashboard
// tabs) use. Counting by slug (rather than the canonical project_id) keeps the
// counts in lock-step with what those filtered lists actually show, even for a
// row whose project_id and slug have drifted (legacy vs canonical projects
// coexist until phase-3 merge). Each count also excludes soft-deleted/archived
// rows so the stat matches its tab's `live()` filter (tasks/documents soft-delete
// via deleted_at, memories archive via archived_at; sessions hard-delete).
// Reused by both listProjects and getProject.
const COUNT_COLUMNS = {
  sessionCount: sql<number>`(select count(*)::int from ${sessions} s where s.project = ${projects.slug})`,
  memoryCount: sql<number>`(select count(*)::int from ${memories} m where m.project = ${projects.slug} and m.archived_at is null)`,
  taskCount: sql<number>`(select count(*)::int from ${tasks} t where t.project = ${projects.slug} and t.deleted_at is null)`,
  documentCount: sql<number>`(select count(*)::int from ${documents} d where d.project = ${projects.slug} and d.deleted_at is null)`
}

// ---------------------------------------------------------------------------
// DTO mapper
// ---------------------------------------------------------------------------

function toDTO(r: typeof projects.$inferSelect, counts?: { sessionCount: number, memoryCount: number, taskCount: number, documentCount: number }): ProjectDTO {
  return {
    id: r.id, slug: r.slug, name: r.name, description: r.description, active: r.active,
    color: r.color, gitRemoteKey: r.gitRemoteKey, repositoryUrl: r.repositoryUrl,
    productionUrl: r.productionUrl, stagingUrl: r.stagingUrl,
    aliases: r.aliases ?? [], localPaths: r.localPaths ?? [], pathPrefixes: r.pathPrefixes ?? [],
    lastActivityAt: r.lastActivityAt?.toISOString() ?? null,
    sessionCount: counts?.sessionCount ?? 0, memoryCount: counts?.memoryCount ?? 0,
    taskCount: counts?.taskCount ?? 0, documentCount: counts?.documentCount ?? 0,
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
    ...COUNT_COLUMNS
  }).from(projects).where(filter.activeOnly ? eq(projects.active, true) : undefined)
    .orderBy(sql`coalesce(${projects.lastActivityAt}, ${projects.createdAt}) desc`)
  return rows.map(r => toDTO(r.project, { sessionCount: r.sessionCount, memoryCount: r.memoryCount, taskCount: r.taskCount, documentCount: r.documentCount }))
}

export async function getProject(slug: string): Promise<ProjectDTO | null> {
  const [r] = await useDb().select({
    project: projects,
    ...COUNT_COLUMNS
  }).from(projects).where(eq(projects.slug, slug)).limit(1)
  return r ? toDTO(r.project, { sessionCount: r.sessionCount, memoryCount: r.memoryCount, taskCount: r.taskCount, documentCount: r.documentCount }) : null
}

export interface CreateProjectInput {
  name: string
  description?: string
  slug?: string
}

export async function createProject(input: CreateProjectInput): Promise<ProjectDTO> {
  const slug = input.slug ?? slugify(input.name)

  // Check for existing project with the same slug (lean existence check, no counts)
  if (await projectRowBySlug(slug)) {
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
  slug?: string
}

export async function updateProject(slug: string, patch: UpdateProjectInput): Promise<ProjectDTO | null> {
  const db = useDb()
  const update: Record<string, unknown> = { updatedAt: new Date() }
  if (patch.name !== undefined) update.name = patch.name
  if (patch.description !== undefined) update.description = patch.description
  if (patch.active !== undefined) update.active = patch.active
  if (patch.color !== undefined) update.color = patch.color
  if (patch.repositoryUrl !== undefined) update.repositoryUrl = patch.repositoryUrl
  if (patch.productionUrl !== undefined) update.productionUrl = patch.productionUrl
  if (patch.stagingUrl !== undefined) update.stagingUrl = patch.stagingUrl
  if (patch.aliases !== undefined) update.aliases = patch.aliases

  const newSlug = patch.slug?.trim()
  if (newSlug && newSlug !== slug) {
    // Check uniqueness: any existing row with newSlug is a conflict
    const [conflict] = await db.select({ id: projects.id }).from(projects).where(eq(projects.slug, newSlug)).limit(1)
    if (conflict) throw new Error(`Project slug "${newSlug}" already exists`)

    // Fetch the canonical project id before the transaction — used for the
    // documents cascade (project_id is unchanged by a rename).
    const existingRow = await projectRowBySlug(slug)
    if (!existingRow) return null

    update.slug = newSlug
    await db.transaction(async (tx) => {
      await tx.update(projects).set(update as Partial<typeof projects.$inferInsert>).where(eq(projects.slug, slug))
      await tx.update(sessions).set({ project: newSlug }).where(eq(sessions.project, slug))
      await tx.update(tasks).set({ project: newSlug }).where(eq(tasks.project, slug))
      await tx.update(memories).set({ project: newSlug }).where(eq(memories.project, slug))
      await tx.update(documents)
        .set({
          project: newSlug,
          path: sql`regexp_replace(${documents.path}, ${'^/projects/' + slug + '/'}, ${'/projects/' + newSlug + '/'})`,
          updatedAt: new Date()
        })
        .where(eq(documents.projectId, existingRow.id))
    })
    return getProject(newSlug)
  }

  const [r] = await db
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
 * Find an existing project matching a human label (e.g. cwd basename) by slug
 * or alias — never creates, no Uncategorized fallback. Returns the raw DB row
 * or null. The match checks: slug = label, slug = slugify(label),
 * aliases @> [label], aliases @> [slugify(label)].
 */
export async function matchProjectByLabel(label: string): Promise<typeof projects.$inferSelect | null> {
  const db = useDb()
  const lslug = slugify(label)
  const [match] = await db.select().from(projects).where(or(
    eq(projects.slug, label),
    eq(projects.slug, lslug),
    sql`${projects.aliases} @> ARRAY[${label}]::text[]`,
    sql`${projects.aliases} @> ARRAY[${lslug}]::text[]`
  )).limit(1)
  return match ?? null
}

/**
 * Resolve a session's project. With a git remote: match by normalized remote key
 * (then aliases), creating on first sight. Without a remote: match by longest
 * registered path prefix, then by cwd/git-root basename label, then AUTO-CREATE a
 * project from the cwd's leaf folder (registering the cwd as a path prefix) unless
 * the cwd is stoplisted, in which case fall back to the seeded Uncategorized bucket.
 */
export async function findOrCreateProject(input: { gitRemote?: string | null, cwd?: string | null, gitRoot?: string | null }): Promise<typeof projects.$inferSelect> {
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
    // 1. Longest registered path-prefix wins.
    if (cwd) {
      const rows = await db.select({ id: projects.id, slug: projects.slug, prefixes: projects.pathPrefixes }).from(projects)
      const hit = longestPrefixMatch(cwd, rows.map(r => ({ id: r.id, slug: r.slug, prefixes: r.prefixes ?? [] })))
      if (hit) {
        const [proj] = await db.select().from(projects).where(eq(projects.id, hit.id)).limit(1)
        if (proj) return touch(proj)
      }
    }
    // 2. Label match: cwd basename, then git-root basename.
    for (const label of [cwd ? basenameOf(cwd) : null, input.gitRoot ? basenameOf(input.gitRoot) : null]) {
      if (label) { const m = await matchProjectByLabel(label); if (m) return touch(m) }
    }
    // 3. Auto-create from the cwd leaf, unless the cwd is bare/scratch (stoplisted).
    if (cwd && isAutoCreatable(cwd)) {
      const prefix = normalizePrefix(cwd)
      const taken = new Set((await db.select({ slug: projects.slug }).from(projects)).map(r => r.slug))
      const slug = nextUniqueSlug(slugify(basenameOf(prefix)) || 'project', taken)
      try {
        const [created] = await db.insert(projects).values({
          slug, name: basenameOf(prefix), pathPrefixes: [prefix], localPaths: [cwd], lastActivityAt: new Date()
        }).returning()
        return created!
      } catch {
        // slug race — re-select by the prefix we tried to register.
        const rows = await db.select().from(projects)
        const racer = rows.find(r => (r.pathPrefixes ?? []).includes(prefix))
        if (racer) return racer
      }
    }
    // 4. Uncategorized fallback (seeded by migration 0019).
    const [u] = await db.select().from(projects).where(eq(projects.slug, 'uncategorized')).limit(1)
    return u!
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
