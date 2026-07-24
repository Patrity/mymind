// server/services/skills.ts
// A skill IS a document: documents.type = 'skill', filed at the reserved path
// /projects/mymind/skills/<name>.md, with the skill contract in frontmatter.
// This module is the ONLY place that knows that mapping.
import { and, eq, isNull } from 'drizzle-orm'
import { useDb } from '../db'
import { documents } from '../db/schema'
import { createDoc, updateDoc, deleteDoc } from './documents'

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

export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const SKILL_BODY_MAX = 20000
export const SKILL_PROJECT = 'mymind'

export function skillPath(name: string): string {
  return `/projects/${SKILL_PROJECT}/skills/${name}.md`
}

/**
 * Structural validation only — the autonomy decision (agent-authored skills go
 * live immediately) means this is the sole gate, so it must be strict about
 * shape while saying nothing about content.
 */
export function validateSkill(input: Partial<SkillInput>): { ok: true } | { ok: false; error: string } {
  const name = (input.name ?? '').trim()
  if (!name) return { ok: false, error: 'name is required' }
  if (!SKILL_NAME_RE.test(name)) return { ok: false, error: `name must be kebab-case (got "${name}")` }
  for (const k of ['description', 'whenToUse', 'body'] as const) {
    if (!(input[k] ?? '').trim()) return { ok: false, error: `${k} is required` }
  }
  if ((input.body ?? '').length > SKILL_BODY_MAX) {
    return { ok: false, error: `body is too long (${input.body!.length} > ${SKILL_BODY_MAX} cap) — split it and reference the detail instead` }
  }
  return { ok: true }
}

export function docToSkill(row: { id: string; content: string; frontmatter: unknown; updatedAt: Date }): Skill | null {
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

function frontmatterFor(input: SkillInput): Record<string, unknown> {
  return {
    kind: 'skill',
    name: input.name.trim(),
    description: input.description.trim(),
    whenToUse: input.whenToUse.trim(),
    active: input.active ?? true,
    source: input.source ?? 'human'
  }
}

const liveSkills = () => and(isNull(documents.deletedAt), eq(documents.type, 'skill'))

export async function listSkills(opts: { activeOnly?: boolean } = {}): Promise<Skill[]> {
  const rows = await useDb().select().from(documents).where(liveSkills())
  const skills = rows.map(r => docToSkill(r)).filter((s): s is Skill => s !== null)
  const filtered = opts.activeOnly ? skills.filter(s => s.active) : skills
  return filtered.sort((a, b) => a.name.localeCompare(b.name))
}

export async function getSkill(name: string): Promise<Skill | null> {
  const [row] = await useDb().select().from(documents)
    .where(and(liveSkills(), eq(documents.path, skillPath(name)))).limit(1)
  return row ? docToSkill(row) : null
}

export async function createSkill(input: SkillInput): Promise<Skill> {
  const v = validateSkill(input)
  if (!v.ok) throw new Error(v.error)
  const name = input.name.trim()
  if (await getSkill(name)) throw new Error(`skill "${name}" already exists`)
  const doc = await createDoc({
    path: skillPath(name),
    title: name,
    content: input.body,
    frontmatter: frontmatterFor({ ...input, name }),
    project: SKILL_PROJECT,
    type: 'skill'
  })
  const skill = await getSkill(name)
  if (!skill) throw new Error(`skill "${name}" was created (doc ${doc.id}) but could not be read back`)
  return skill
}

export async function updateSkill(name: string, patch: Partial<SkillInput>): Promise<Skill | null> {
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
  if (merged.name !== name && await getSkill(merged.name)) throw new Error(`skill "${merged.name}" already exists`)
  await updateDoc(current.id, {
    path: skillPath(merged.name),
    title: merged.name,
    content: merged.body,
    frontmatter: frontmatterFor(merged),
    type: 'skill'
  })
  return getSkill(merged.name)
}

export async function deleteSkill(name: string): Promise<boolean> {
  const s = await getSkill(name)
  if (!s) return false
  return deleteDoc(s.id)
}
