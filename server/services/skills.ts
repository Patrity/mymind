// server/services/skills.ts
// Cycle 74: a skill is a row in `agent_skills` whose `content` is markdown with YAML
// frontmatter — the single source of truth. The name/description/when_to_use/active/source
// columns are DERIVED from that markdown on every write and never edited directly.
// (Before cycle 74 skills were documents: type='skill' at /projects/mymind/skills/<name>.md.
// migrateSkillsFromDocuments moves those rows over; skillPath/docToSkill remain for it.)
// This module is the ONLY place that knows the storage mapping.
import { createHash } from 'node:crypto'
import { and, asc, eq, inArray, isNull, like, sql } from 'drizzle-orm'
import { useDb } from '../db'
import { agentSkills, documents, type AgentSkillRow } from '../db/schema'
import { publishChange } from '../utils/live-bus'
import { recordRevision, listRevisions, getRevision, type RevisionActor } from '../lib/agent/config/revisions'
import { splitFrontmatter, joinFrontmatter, setFrontmatterKey } from '../../shared/utils/frontmatter'
import { COMMAND_NAME_RE, RESERVED_COMMAND_NAMES } from '../../shared/types/commands'

export interface Skill {
  id: string
  name: string
  description: string
  whenToUse: string
  active: boolean
  source: 'human' | 'agent'
  body: string
  updatedAt: string
}

export interface SkillInput {
  name: string
  description: string
  whenToUse: string
  body: string
  active?: boolean
  source?: 'human' | 'agent'
}

export interface SkillSource {
  id: string
  slug: string
  content: string
  contentHash: string
  active: boolean
  source: 'human' | 'agent'
  updatedAt: string
}

/** Thrown by saveSkillSource when the caller's expectedHash is stale — carries what is there now
 *  so the editor can show the other writer's version instead of silently clobbering it. */
export class ConflictError extends Error {
  current: { content: string, contentHash: string }
  constructor(current: { content: string, contentHash: string }) {
    super('skill was changed by someone else — reload and re-apply your edit')
    this.name = 'ConflictError'
    this.current = current
  }
}

/** Shared with prompt macros — see COMMAND_NAME_RE. Both sources claim the same `/` namespace,
 *  so they must agree on what a name may look like. */
export const SKILL_NAME_RE = COMMAND_NAME_RE
export const SKILL_BODY_MAX = 20000
export const SKILL_PROJECT = 'mymind'

/** The pre-cycle-74 document path of a skill — only the documents→agent_skills move uses it. */
export function skillPath(name: string): string {
  return `/projects/${SKILL_PROJECT}/skills/${name}.md`
}

/**
 * Structural validation only — the autonomy decision (agent-authored skills go
 * live immediately) means this is the sole gate, so it must be strict about
 * shape while saying nothing about content.
 */
export function validateSkill(input: Partial<SkillInput>): { ok: true } | { ok: false, error: string } {
  const name = (input.name ?? '').trim()
  if (!name) return { ok: false, error: 'name is required' }
  if (!SKILL_NAME_RE.test(name)) return { ok: false, error: `name must be kebab-case (got "${name}")` }
  // Against the TRIMMED name, because that is what createSkill stores (`input.name.trim()`).
  // Checking the raw one let `" clear "` through validation and land as a skill named `clear` —
  // permanently shadowed by the built-in and unreachable from `/`, which is exactly the
  // collision this guard exists to prevent (spec Risk #4).
  if (RESERVED_COMMAND_NAMES.includes(name)) {
    return { ok: false, error: `"${name}" is a reserved command name` }
  }
  for (const k of ['description', 'whenToUse', 'body'] as const) {
    if (!(input[k] ?? '').trim()) return { ok: false, error: `${k} is required` }
  }
  if ((input.body ?? '').length > SKILL_BODY_MAX) {
    return { ok: false, error: `body is too long (${input.body!.length} > ${SKILL_BODY_MAX} cap) — split it and reference the detail instead` }
  }
  return { ok: true }
}

/** Maps a pre-cycle-74 skill DOCUMENT to a Skill (null when it is not one). Used by the move. */
export function docToSkill(row: { id: string, content: string, frontmatter: unknown, updatedAt: Date }): Skill | null {
  const fm = (row.frontmatter ?? {}) as Record<string, unknown>
  if (fm.kind !== 'skill') return null
  const name = typeof fm.name === 'string' ? fm.name : ''
  if (!name) return null
  return {
    id: row.id,
    name,
    description: typeof fm.description === 'string' ? fm.description : '',
    whenToUse: typeof fm.whenToUse === 'string' ? fm.whenToUse : '',
    active: fm.active === undefined ? true : fm.active === true,
    source: fm.source === 'agent' ? 'agent' : 'human',
    body: row.content,
    updatedAt: row.updatedAt.toISOString()
  }
}

// ---- markdown <-> fields --------------------------------------------------------------

const hashOf = (content: string) => createHash('sha256').update(content).digest('hex')

/** The canonical markdown for a skill. Frontmatter uses snake_case `when_to_use`; the DTO keeps
 *  `whenToUse`. */
export function skillToMarkdown(input: SkillInput): string {
  return joinFrontmatter({
    name: input.name.trim(),
    description: input.description.trim(),
    when_to_use: input.whenToUse.trim(),
    active: input.active ?? true,
    source: input.source ?? 'human'
  }, input.body)
}

/** Parses skill markdown back into fields. Lenient on types (a non-string field reads as '');
 *  validateSkill is what rejects bad shape. */
export function parseSkillMarkdown(content: string): { input: Required<SkillInput>, error?: string } {
  const { data, body, error } = splitFrontmatter(content)
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    input: {
      name: str(data.name).trim(),
      description: str(data.description).trim(),
      whenToUse: str(data.when_to_use).trim(),
      body,
      active: data.active === undefined ? true : data.active === true,
      source: data.source === 'agent' ? 'agent' : 'human'
    },
    ...(error ? { error } : {})
  }
}

function derivedColumns(content: string, input: Required<SkillInput>) {
  return {
    content,
    contentHash: hashOf(content),
    name: input.name,
    description: input.description,
    whenToUse: input.whenToUse,
    active: input.active,
    source: input.source
  }
}

function rowToSkill(row: AgentSkillRow): Skill {
  return {
    id: row.id,
    name: row.slug,
    description: row.description ?? '',
    whenToUse: row.whenToUse ?? '',
    active: row.active,
    source: row.source === 'agent' ? 'agent' : 'human',
    body: splitFrontmatter(row.content).body,
    updatedAt: row.updatedAt.toISOString()
  }
}

function rowToSource(row: AgentSkillRow): SkillSource {
  return {
    id: row.id,
    slug: row.slug,
    content: row.content,
    contentHash: row.contentHash,
    active: row.active,
    source: row.source === 'agent' ? 'agent' : 'human',
    updatedAt: row.updatedAt.toISOString()
  }
}

async function rowBySlug(slug: string): Promise<AgentSkillRow | null> {
  const [row] = await useDb().select().from(agentSkills).where(eq(agentSkills.slug, slug)).limit(1)
  return row ?? null
}

// ---- reads ------------------------------------------------------------------------------

export async function listSkills(opts: { activeOnly?: boolean } = {}): Promise<Skill[]> {
  const rows = await useDb().select().from(agentSkills)
    .where(opts.activeOnly ? eq(agentSkills.active, true) : undefined)
    .orderBy(asc(agentSkills.slug))
  return rows.map(rowToSkill).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * `activeOnly` off by default: the CRUD paths — updateSkill, deleteSkill, the existence check in
 * createSkill — must see a deactivated skill or they would happily create a second one at the
 * same slug. Prompt-assembly callers (the `/skill` slash tier) pass `true`, because a skill the
 * menu hides must not still be force-loadable into a turn.
 */
export async function getSkill(name: string, opts: { activeOnly?: boolean } = {}): Promise<Skill | null> {
  const row = await rowBySlug(name)
  if (!row) return null
  if (opts.activeOnly && !row.active) return null
  return rowToSkill(row)
}

export async function getSkillSource(slug: string): Promise<SkillSource | null> {
  const row = await rowBySlug(slug)
  return row ? rowToSource(row) : null
}

export async function listSkillRevisions(slug: string): Promise<{ id: string, content: string, actor: string, createdAt: string }[]> {
  const row = await rowBySlug(slug)
  return row ? listRevisions('skill', row.id) : []
}

// ---- writes -----------------------------------------------------------------------------
// Every write: validate → write content + derived columns → record a revision → publish.

export async function createSkill(input: SkillInput, opts: { actor?: RevisionActor } = {}): Promise<Skill> {
  const v = validateSkill(input)
  if (!v.ok) throw new Error(v.error)
  const name = input.name.trim()
  if (await rowBySlug(name)) throw new Error(`skill "${name}" already exists`)
  const content = skillToMarkdown({ ...input, name })
  const parsed = parseSkillMarkdown(content).input
  const [row] = await useDb().insert(agentSkills).values({ slug: name, ...derivedColumns(content, parsed) }).returning()
  await recordRevision({ targetKind: 'skill', targetId: row!.id, content, actor: opts.actor ?? input.source ?? 'human' })
  publishChange({ resource: 'agentSkill', action: 'created', id: row!.id })
  return rowToSkill(row!)
}

export async function updateSkill(
  name: string, patch: Partial<SkillInput>, opts: { actor?: RevisionActor } = {}
): Promise<Skill | null> {
  const current = await getSkill(name)
  if (!current) return null
  const merged: SkillInput = {
    name: patch.name?.trim() || current.name,
    description: patch.description ?? current.description,
    whenToUse: patch.whenToUse ?? current.whenToUse,
    body: patch.body ?? current.body,
    active: patch.active ?? current.active,
    source: patch.source ?? current.source
  }
  const v = validateSkill(merged)
  if (!v.ok) throw new Error(v.error)
  if (merged.name !== name && await rowBySlug(merged.name)) throw new Error(`skill "${merged.name}" already exists`)
  // Final review M8: a write that changes ONLY `active` (the /skills toggle, or edit_skill with
  // just active) flips that one frontmatter line of the stored markdown, byte-stable, instead of
  // regenerating the file from fields — which would drop any extra key or formatting Tony added
  // in the raw editor. Any other change still regenerates.
  const onlyActive = merged.active !== current.active
    && merged.name === current.name && merged.description === current.description
    && merged.whenToUse === current.whenToUse && merged.body === current.body && merged.source === current.source
  const stored = onlyActive ? await rowBySlug(name) : null
  const content = stored ? setFrontmatterKey(stored.content, 'active', merged.active) : skillToMarkdown(merged)
  const [row] = await useDb().update(agentSkills)
    .set({ slug: merged.name, ...derivedColumns(content, parseSkillMarkdown(content).input), updatedAt: sql`now()` })
    .where(eq(agentSkills.id, current.id)).returning()
  if (!row) return null
  await recordRevision({ targetKind: 'skill', targetId: row.id, content, actor: opts.actor ?? 'human' })
  publishChange({ resource: 'agentSkill', action: 'updated', id: row.id })
  return rowToSkill(row)
}

/**
 * Hard-deletes the row, first recording a final revision of the content being deleted (by
 * `actor`) so the delete shows in history. Revisions carry no FK and survive; restoreSkill
 * re-inserts under the SAME id, so an undone delete keeps its whole history.
 */
export async function deleteSkill(name: string, opts: { actor?: RevisionActor } = {}): Promise<boolean> {
  const deleted = await useDb().transaction(async (tx) => {
    const [row] = await tx.delete(agentSkills).where(eq(agentSkills.slug, name)).returning()
    if (!row) return null
    await recordRevision({ targetKind: 'skill', targetId: row.id, content: row.content, actor: opts.actor ?? 'human' }, tx)
    return row
  })
  if (!deleted) return false
  publishChange({ resource: 'agentSkill', action: 'deleted', id: deleted.id })
  return true
}

/**
 * Re-inserts a deleted skill under its ORIGINAL id (the delete_skill undo), through the same
 * validation as saveSkillSource, and records a revision. Throws when the slug or id is taken.
 */
export async function restoreSkill(priorId: string, content: string, actor: RevisionActor): Promise<SkillSource> {
  const { input, error } = parseSkillMarkdown(content)
  if (error) throw new Error(`invalid frontmatter: ${error}`)
  const v = validateSkill(input)
  if (!v.ok) throw new Error(v.error)
  if (await rowBySlug(input.name)) throw new Error(`skill "${input.name}" already exists`)
  const [row] = await useDb().insert(agentSkills)
    .values({ id: priorId, slug: input.name, ...derivedColumns(content, input) }).returning()
  await recordRevision({ targetKind: 'skill', targetId: row!.id, content, actor })
  publishChange({ resource: 'agentSkill', action: 'created', id: row!.id })
  return rowToSource(row!)
}

/**
 * Compare-and-swap write of a skill's whole markdown. `expectedHash` is the contentHash the
 * editor loaded; a mismatch throws ConflictError(current). `expectedHash: null` means CREATE-ONLY:
 * it inserts a new skill at `slug`, and throws ConflictError(current) if one already exists (a
 * "new skill" save must never silently overwrite). The frontmatter `name` must equal `slug`
 * (renames go through updateSkill); invalid content is rejected, never stored.
 */
export async function saveSkillSource(
  slug: string, content: string, expectedHash: string | null, actor: RevisionActor
): Promise<SkillSource> {
  const { input, error } = parseSkillMarkdown(content)
  if (error) throw new Error(`invalid frontmatter: ${error}`)
  const v = validateSkill(input)
  if (!v.ok) throw new Error(v.error)
  if (input.name !== slug) throw new Error(`frontmatter name "${input.name}" must match the skill "${slug}"`)

  const db = useDb()
  const existing = await rowBySlug(slug)
  let row: AgentSkillRow | undefined
  if (!existing) {
    if (expectedHash !== null) throw new Error(`no skill named "${slug}"`)
    ;[row] = await db.insert(agentSkills).values({ slug, ...derivedColumns(content, input) }).returning()
  } else {
    if (expectedHash === null || existing.contentHash !== expectedHash) {
      throw new ConflictError({ content: existing.content, contentHash: existing.contentHash })
    }
    // The hash is re-checked IN the UPDATE so a write landing between the read above and this
    // statement still loses rather than being clobbered.
    ;[row] = await db.update(agentSkills)
      .set({ ...derivedColumns(content, input), updatedAt: sql`now()` })
      .where(and(eq(agentSkills.id, existing.id), eq(agentSkills.contentHash, expectedHash)))
      .returning()
    if (!row) {
      const now = await rowBySlug(slug)
      throw new ConflictError({ content: now?.content ?? '', contentHash: now?.contentHash ?? '' })
    }
  }
  await recordRevision({ targetKind: 'skill', targetId: row!.id, content, actor })
  publishChange({ resource: 'agentSkill', action: existing ? 'updated' : 'created', id: row!.id })
  return rowToSource(row!)
}

/** Restores a skill to one of its revisions (recorded as a new revision by `actor`). */
export async function revertSkill(slug: string, revisionId: string, actor: RevisionActor): Promise<SkillSource> {
  const row = await rowBySlug(slug)
  if (!row) throw new Error(`no skill named "${slug}"`)
  const rev = await getRevision(revisionId)
  if (!rev || rev.targetKind !== 'skill' || rev.targetId !== row.id) {
    throw new Error(`revision ${revisionId} does not belong to skill "${slug}"`)
  }
  return saveSkillSource(slug, rev.content, row.contentHash, actor)
}

// ---- one-time data move (cycle 74) ------------------------------------------------------

const LEGACY_SKILL_DIR = `/projects/${SKILL_PROJECT}/skills/`

/**
 * Moves live skill documents into agent_skills: rebuilds the markdown from the document's jsonb
 * frontmatter + content, inserts it, and soft-deletes the document — in one transaction per
 * document, with a `system` revision. Idempotent: a slug already in agent_skills is filtered out
 * (and its document left alone).
 *
 * One bad document must not block the rest on every boot: each is tried on its own, and any that
 * is not moved — no `kind: skill`/name, fails validation, or throws — is left live and reported
 * in `skipped` with the reason.
 *
 * Every OTHER live `type='skill'` document is reported in `skipped` too (final review M7) — one
 * whose slug already exists in agent_skills (e.g. `seed:skills` ran first), or one that lives
 * outside the legacy skills folder (moved with move_document). Nothing moves it, and Bridget no
 * longer reads skills from documents, so without a line in the boot log it would silently vanish.
 *
 * `onlyPaths` is a TEST seam: the dev DB is shared and holds real skill documents.
 */
export async function migrateSkillsFromDocuments(
  opts: { onlyPaths?: string[] } = {}
): Promise<{ moved: number, skipped: { path: string, reason: string }[] }> {
  const db = useDb()
  const docs = await db.select().from(documents).where(and(
    isNull(documents.deletedAt),
    eq(documents.type, 'skill'),
    like(documents.path, `${LEGACY_SKILL_DIR}%`),
    opts.onlyPaths ? inArray(documents.path, opts.onlyPaths) : undefined,
    sql`not exists (select 1 from agent_skills s where s.slug =
          regexp_replace(${documents.path}, '^.*/([^/]+)\\.md$', '\\1'))`
  ))

  let moved = 0
  const skipped: { path: string, reason: string }[] = []
  for (const doc of docs) {
    try {
      const skill = docToSkill(doc)
      if (!skill) {
        skipped.push({ path: doc.path, reason: 'not a skill document (missing kind: skill or name)' })
        continue
      }
      // Basename — the same slug the NOT EXISTS above derives in SQL.
      const slug = doc.path.slice(doc.path.lastIndexOf('/') + 1).replace(/\.md$/, '')
      const content = skillToMarkdown({ ...skill, name: slug })
      const parsed = parseSkillMarkdown(content).input
      const v = validateSkill(parsed)
      if (!v.ok) throw new Error(v.error)
      // No ON CONFLICT: the NOT EXISTS above is the idempotence guard; a slug that appears between
      // the select and here fails this document (reported) rather than soft-deleting a document
      // whose content never landed anywhere.
      const inserted = await db.transaction(async (tx) => {
        const [row] = await tx.insert(agentSkills).values({ slug, ...derivedColumns(content, parsed) }).returning()
        await tx.update(documents).set({ deletedAt: sql`now()` }).where(eq(documents.id, doc.id))
        await recordRevision({ targetKind: 'skill', targetId: row!.id, content, actor: 'system' }, tx)
        return row!
      })
      moved++
      publishChange({ resource: 'agentSkill', action: 'created', id: inserted.id })
    } catch (err) {
      skipped.push({ path: doc.path, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  const reported = new Set([...docs.map(d => d.path)])
  const leftover = await db.select({ path: documents.path }).from(documents).where(and(
    isNull(documents.deletedAt),
    eq(documents.type, 'skill'),
    opts.onlyPaths ? inArray(documents.path, opts.onlyPaths) : undefined
  ))
  for (const { path } of leftover) {
    if (reported.has(path)) continue
    const slug = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '')
    skipped.push({
      path,
      reason: path.startsWith(LEGACY_SKILL_DIR)
        ? `a skill named "${slug}" already exists in agent_skills — this document was left live and is not read by Bridget`
        : `outside ${LEGACY_SKILL_DIR} — not moved; recreate it on /skills if it is still wanted`
    })
  }
  return { moved, skipped }
}
