// server/lib/agent/skills-config.ts
// The agent-skills kill-switch. Same shape as persona.ts: one settings row,
// module-level cache, explicit invalidation. Default ON.
import { eq } from 'drizzle-orm'
import { useDb } from '../../db'
import { settings } from '../../db/schema'

export const SKILLS_ENABLED_KEY = 'agent_skills_enabled'
let cache: boolean | null = null

export async function skillsEnabled(): Promise<boolean> {
  if (cache !== null) return cache
  const [row] = await useDb().select().from(settings).where(eq(settings.key, SKILLS_ENABLED_KEY)).limit(1)
  const v = row?.value as { enabled?: unknown } | undefined
  cache = typeof v?.enabled === 'boolean' ? v.enabled : true
  return cache
}

export async function setSkillsEnabled(enabled: boolean): Promise<void> {
  await useDb().insert(settings).values({ key: SKILLS_ENABLED_KEY, value: { enabled }, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: { enabled }, updatedAt: new Date() } })
  cache = enabled
}

export function invalidateSkillsEnabled(): void { cache = null }
